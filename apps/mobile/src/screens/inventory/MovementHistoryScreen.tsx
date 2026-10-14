import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { Card, EmptyState, ListRow, QuantityText, Screen, Tag } from '../../components';
import { localMovements, localProducts } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useTheme } from '../../theme';
import type { InventoryStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<InventoryStackParamList, 'MovementHistory'>;

/**
 * Movement history for one item.
 *
 * The ledger is the source of truth for stock: on-hand quantity is always derived
 * from these rows (never stored as a mutable number), which is why the same
 * figures appear here, on the inventory list and on the server.
 */
export function MovementHistoryScreen({ route }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business } = useAuth();
  const itemId = route.params?.itemId;

  const currency = business?.currency ?? 'BDT';

  const loader = useCallback(async () => {
    const [movements, products] = await Promise.all([itemId ? localMovements(itemId) : localMovements(), localProducts({})]);
    return { movements, product: products.find((entry) => entry.id === itemId) ?? null };
  }, [itemId]);

  const { data } = useAsyncData(loader, [loader]);

  return (
    <Screen title={data?.product?.name ?? t('inventory.movements')} subtitle={itemId ?? undefined}>
      {data?.product ? (
        <Card>
          <Text style={[typography.body, { color: colors.text }]}>
            {t('inventory.onHand')}: {data.product.onHand} {data.product.unit}
          </Text>
          {data.product.reorderLevel ? (
            <Text style={[typography.caption, { color: colors.textMuted }]}>
              {t('inventory.reorderLevel')}: {data.product.reorderLevel} {data.product.unit}
            </Text>
          ) : null}
        </Card>
      ) : null}

      <Card>
        {data && data.movements.length > 0 ? (
          data.movements.map((movement) => (
            <ListRow
              key={movement.id}
              title={`${movement.direction === 'IN' ? '+' : '−'} ${movement.quantity} ${movement.unit}`}
              subtitle={`${movement.occurredAt} • ${movement.sourceType}${movement.reason ? ` • ${movement.reason}` : ''}`}
              badge={<Tag text={movement.direction} tone={movement.direction === 'IN' ? 'success' : 'warning'} />}
              right={<QuantityText value={movement.quantity} />}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('inventory.balanceAsOf')} />
        )}
      </Card>
      <View style={{ height: spacing.lg }} />
      <Text style={[typography.caption, { color: colors.textMuted }]}>{currency}</Text>
    </Screen>
  );
}
