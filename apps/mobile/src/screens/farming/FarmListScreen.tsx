import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, Notice, QuantityText, Screen, SectionTitle } from '../../components';
import { localFarms } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'FarmList'>;

/**
 * Farms and their units.
 *
 * Note the online-only boundary, which mirrors the server's sync service: farms and
 * farm units have **no outbox event type** (only `cycle.create` and the operation
 * events do), so creating them requires the internet. The screen says so instead of
 * queueing something the server would answer `UNKNOWN_EVENT` for.
 */
export function FarmListScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { can } = useAuth();
  const { online } = useNetwork();
  const { syncNow, syncing } = useSync();

  const loader = useCallback(() => localFarms(), []);
  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  return (
    <Screen
      title={t('farming.farms')}
      onRefresh={() => void syncNow().then(reload)}
      refreshing={syncing}
      footer={
        <View style={{ marginTop: spacing.lg }}>
          <Button label={t('farming.newFarm')} onPress={() => navigation.navigate('NewFarm')} disabled={!online || !can('farming.setup')} fullWidth />
          {!online ? <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.sm }]}>{t('auth.needInternet')}</Text> : null}
        </View>
      }
    >
      {!can('farming.setup') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}

      <Card>
        {data && data.length > 0 ? (
          data.map((farm) => (
            <ListRow
              key={farm.id}
              title={farm.name}
              subtitle={`${farm.units.length} ${t('farming.units').toLowerCase()}${farm.address ? ` • ${farm.address}` : ''}`}
              right={farm.area ? <QuantityText value={farm.area} unit={farm.areaUnit ?? ''} /> : undefined}
              onPress={() => navigation.navigate('FarmUnits', { farmId: farm.id, farmName: farm.name })}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('auth.needInternet')} />
        )}
      </Card>

      <SectionTitle title={t('farming.units')} />
      {data?.map((farm) => (
        <View key={farm.id}>
          <Text style={[typography.subheading, { color: colors.text }]}>{farm.name}</Text>
          {farm.units.length === 0 ? (
            <Text style={[typography.caption, { color: colors.textMuted, marginBottom: spacing.sm }]}>{t('common.none')}</Text>
          ) : (
            farm.units.map((unit) => (
              <ListRow
                key={unit.id}
                title={unit.name}
                subtitle={`${unit.kind}${unit.capacity ? ` • ${unit.capacity} ${unit.capacityUnit ?? ''}` : ''}`}
              />
            ))
          )}
        </View>
      ))}

      {loading && !data ? <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.loading')}</Text> : null}
    </Screen>
  );
}
