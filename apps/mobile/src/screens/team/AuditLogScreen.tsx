import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Text } from 'react-native';

import * as api from '../../api/endpoints';
import { useAuth } from '../../auth/AuthProvider';
import { Card, EmptyState, ListRow, Notice, Screen } from '../../components';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'AuditLog'>;

/**
 * Activity log.
 *
 * Served live by the server (there is no offline mirror of `audit_logs`), because
 * an audit trail that a device could rewrite locally would be worthless. Access
 * needs `audit.view`.
 */
export function AuditLogScreen(_props: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { can } = useAuth();
  const { online } = useNetwork();

  const loader = useCallback(async () => (online && can('audit.view') ? api.auditLog(200) : []), [online, can]);
  const { data, loading, reload } = useAsyncData(loader, [loader]);

  return (
    <Screen title={t('team.audit')} onRefresh={reload} refreshing={loading}>
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}
      {!can('audit.view') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}

      <Card>
        {data && data.length > 0 ? (
          data.map((entry) => (
            <ListRow
              key={entry.id}
              title={entry.action}
              subtitle={`${entry.at.slice(0, 19).replace('T', ' ')} • ${entry.actor ?? '—'} • ${entry.entityType}${
                entry.detail && Object.keys(entry.detail).length > 0 ? ` • ${JSON.stringify(entry.detail).slice(0, 80)}` : ''
              }`}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={online ? t('common.none') : t('auth.needInternet')} />
        )}
      </Card>
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('team.audit')}</Text>
    </Screen>
  );
}
