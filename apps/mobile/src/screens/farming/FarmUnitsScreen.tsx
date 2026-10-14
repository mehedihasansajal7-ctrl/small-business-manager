import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { View } from 'react-native';

import { FARM_UNIT_KINDS } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, ListRow, Notice, QuantityText, Screen, SectionTitle } from '../../components';
import { localFarms } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'FarmUnits'>;

/**
 * Units (plots, sheds, ponds…) belonging to one farm.
 *
 * Unit kinds come from `@sbm/domain`'s `FARM_UNIT_KINDS`, so the phone offers
 * exactly the values the server accepts.
 */
export function FarmUnitsScreen({ navigation, route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, language } = useI18n();
  const { can } = useAuth();
  const { online } = useNetwork();
  const { syncing, syncNow } = useSync();
  const { farmId, farmName } = route.params;

  const loader = useCallback(async () => {
    const farms = await localFarms();
    return farms.find((farm) => farm.id === farmId) ?? null;
  }, [farmId]);

  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  const kindLabels = new Map(FARM_UNIT_KINDS.map((entry) => [entry.kind, language === 'bn' ? entry.nameBn : entry.name]));

  return (
    <Screen
      title={farmName}
      subtitle={t('farming.units')}
      onRefresh={() => void syncNow().then(reload)}
      refreshing={syncing}
      footer={
        <View style={{ marginTop: spacing.lg }}>
          <Button
            label={t('farming.newUnit')}
            onPress={() => navigation.navigate('NewFarmUnit', { farmId })}
            disabled={!online || !can('farming.setup')}
            fullWidth
          />
        </View>
      }
    >
      {!online ? <Notice tone="warning" body={t('auth.needInternet')} /> : null}

      <Card>
        {data && data.units.length > 0 ? (
          data.units.map((unit) => (
            <ListRow
              key={unit.id}
              title={unit.name}
              subtitle={kindLabels.get(unit.kind) ?? unit.kind}
              right={
                unit.capacity ? <QuantityText value={unit.capacity} unit={unit.capacityUnit ?? ''} /> : unit.area ? <QuantityText value={unit.area} unit={unit.areaUnit ?? ''} /> : undefined
              }
              onPress={() => navigation.navigate('NewCycle', { farmId, unitId: unit.id })}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={loading ? t('common.loading') : t('auth.needInternet')} />
        )}
      </Card>

      <SectionTitle title={t('farming.newCycle')} />
      <Button label={t('farming.newCycle')} variant="secondary" onPress={() => navigation.navigate('NewCycle', { farmId })} fullWidth />
      <Notice tone="info" body={t('offline.coreWorksOffline')} />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{kindLabels.size} unit kinds available</Text>
    </Screen>
  );
}
