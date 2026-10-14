import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { ATTACHMENT_NOTICE, attachmentsFor, flushAttachments, queueAttachment, type QueuedAttachment } from '../offline/attachments';
import { useI18n } from '../i18n';
import { useNetwork } from '../lib/network';
import { statusColors, useTheme } from '../theme';
import { Button } from './Button';
import { Notice } from './Notice';

/**
 * Camera / gallery attachment picker.
 *
 * Flow: pick or shoot → normalise the filename and MIME → queue locally → try to
 * upload immediately. The queue is retried by the sync controller.
 *
 * What it never does: touch the business transaction. An attachment failure is
 * reported in its own line and cannot roll back or duplicate the sale the photo
 * belongs to (see the header comment of `src/offline/attachments.ts`).
 *
 * The wording shown to the user is fixed by the spec and by the server's own
 * response note: the image is stored on the shop's server, and partners see it
 * only after syncing — not instantly, and not peer-to-peer.
 */
export function PhotoPicker({
  entityType,
  entityId,
  label,
  onQueued,
}: {
  entityType: string;
  entityId: string;
  label?: string;
  onQueued?: () => void;
}) {
  const { colors, radius, spacing, typography, scheme } = useTheme();
  const { t, language } = useI18n();
  const { businessId } = useAuth();
  const { online } = useNetwork();
  const [queue, setQueue] = useState<QueuedAttachment[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const notice = ATTACHMENT_NOTICE[language];

  const refreshQueue = useCallback(async () => {
    setQueue(await attachmentsFor(entityType, entityId));
  }, [entityType, entityId]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const handleAsset = async (asset: ImagePicker.ImagePickerAsset) => {
    if (!businessId) return;
    const fileName = asset.fileName ?? `photo-${Date.now()}.jpg`;
    const mime = asset.mimeType ?? 'image/jpeg';
    await queueAttachment({ businessId, entityType, entityId, localUri: asset.uri, fileName, mime, sizeBytes: asset.fileSize });
    await refreshQueue();
    setMessage(online ? null : t('photo.queued'));
    onQueued?.();
    if (online) {
      const flushed = await flushAttachments(businessId);
      if (flushed.uploaded === 0 && flushed.pending > 0) setMessage(t('photo.queued'));
      await refreshQueue();
    }
  };

  const pick = async (from: 'camera' | 'gallery') => {
    setBusy(true);
    setMessage(null);
    try {
      if (from === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setMessage(t('photo.permissionDenied'));
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          // Compressed on purpose: the API caps an attachment at 5 MB, and a
          // modern phone camera easily exceeds that per frame.
          quality: 0.5,
          exif: false,
          allowsEditing: false,
        });
        if (!result.canceled && result.assets[0]) await handleAsset(result.assets[0]);
      } else {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          setMessage(t('photo.permissionDenied'));
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.5,
          exif: false,
          allowsEditing: false,
        });
        if (!result.canceled && result.assets[0]) await handleAsset(result.assets[0]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={[typography.label, { color: colors.textMuted, marginBottom: spacing.xs }]}>{label ?? t('photo.add')}</Text>

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label={t('photo.camera')} variant="secondary" compact loading={busy} onPress={() => void pick('camera')} />
        <Button label={t('photo.gallery')} variant="secondary" compact loading={busy} onPress={() => void pick('gallery')} />
      </View>

      {/* The honest promise: stored on the server, visible to partners after sync. */}
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.xs }]}>{notice}</Text>

      {message ? <Text style={[typography.caption, { color: colors.info, marginTop: spacing.xs }]}>{message}</Text> : null}

      {queue.length > 0 ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
          {queue.map((item) => {
            const pair = statusColors(scheme, item.status === 'UPLOADED' ? 'SYNCED' : item.status === 'FAILED' ? 'REJECTED' : 'PENDING');
            return (
              <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <Image source={{ uri: item.local_uri }} style={{ width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt }} />
                <View style={{ flex: 1 }}>
                  <Text style={[typography.caption, { color: colors.text }]} numberOfLines={1}>
                    {item.file_name}
                  </Text>
                  <Text style={[typography.caption, { color: pair.text }]} numberOfLines={1}>
                    {item.status === 'UPLOADED' ? 'Uploaded' : item.status === 'FAILED' ? item.last_error ?? 'Failed' : t('offline.proposal')}
                  </Text>
                </View>
              </View>
            );
          })}
          {!online ? <Notice tone="warning" body={notice} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export const photoPickerStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
