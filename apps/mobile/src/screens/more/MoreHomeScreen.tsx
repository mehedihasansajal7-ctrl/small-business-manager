import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Text, View } from 'react-native';

import { partnerCountGuidance } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, ListRow, Notice, OfflineBanner, Screen, SectionTitle, Tag } from '../../components';
import { useI18n } from '../../i18n';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'MoreHome'>;

/**
 * The "More" hub: catalogue, team, AI, sync and settings.
 *
 * On a phone these live one level down from the bottom tabs; on a tablet the
 * drawer exposes them directly. Keeping one hub for both means a single place to
 * add a module later.
 */
export function MoreHomeScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, businesses, user, useCachedData } = useAuth();
  const { online } = useNetwork();
  const { summary, syncing, syncNow, attachmentsPending } = useSync();

  const guidance = partnerCountGuidance(businesses.length);

  return (
    <Screen title={t('nav.more')} subtitle={business?.name}>
      <OfflineBanner online={online} pending={summary?.pending ?? 0} conflicts={summary?.conflictsOpen ?? 0} lastSyncedAt={summary?.lastSyncedAt ?? null} syncing={syncing} onSyncNow={() => void syncNow()} />
      {useCachedData ? <Notice tone="info" body={t('reports.offlineNote')} /> : null}

      <Card>
        <ListRow title={user?.displayName ?? '—'} subtitle={user?.email} badge={<Tag text={business?.member.role ?? '—'} tone="primary" />} />
        <ListRow title={t('nav.switchBusiness')} subtitle={`${businesses.length} workspace(s)`} onPress={() => navigation.navigate('BusinessSwitcher')} />
        <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{guidance.message}</Text>
      </Card>

      <SectionTitle title={t('nav.catalogue')} />
      <Card>
        <ListRow title={t('nav.customers')} onPress={() => navigation.navigate('Customers')} />
        <ListRow title={t('nav.suppliers')} onPress={() => navigation.navigate('Suppliers')} />
        <ListRow title={t('nav.products')} onPress={() => navigation.navigate('Products')} />
      </Card>

      <SectionTitle title={t('nav.team')} />
      <Card>
        <ListRow title={t('nav.team')} subtitle={t('team.needsInternet')} onPress={() => navigation.navigate('Team')} />
        <ListRow title={t('team.audit')} onPress={() => navigation.navigate('AuditLog')} />
      </Card>

      <SectionTitle title={t('nav.ai')} />
      <Card>
        <ListRow title={t('nav.ai')} subtitle={t('ai.notConfigured')} onPress={() => navigation.navigate('AIAgent')} />
      </Card>

      <SectionTitle title={t('nav.sync')} />
      <Card>
        <ListRow
          title={t('sync.title')}
          subtitle={`${summary?.pending ?? 0} • ${t('sync.attachmentsPending')}: ${attachmentsPending}`}
          badge={summary?.conflictsOpen ? <Tag text={String(summary.conflictsOpen)} tone="danger" /> : undefined}
          onPress={() => navigation.navigate('SyncStatus')}
        />
        <ListRow title={t('nav.settings')} onPress={() => navigation.navigate('Settings')} />
      </Card>

      <View style={{ height: spacing.lg }} />
      <Text style={[typography.caption, { color: colors.textMuted }]}>{t('offline.coreWorksOffline')}</Text>
    </Screen>
  );
}
