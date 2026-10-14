import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, EmptyState, Field, ListRow, MoneyText, Notice, QuantityText, Screen, Segmented, Tag } from '../../components';
import { localProducts } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData, useReloadOnFocus } from '../../lib/useAsyncData';
import { useTheme } from '../../theme';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Products'>;

type Filter = 'ALL' | 'PRODUCT' | 'INPUT' | 'OUTPUT' | 'LIVESTOCK' | 'SERVICE';

/**
 * Product catalogue.
 *
 * `purchasePrice` and `taxRate` are only present when the caller may see cost;
 * when they are absent the row shows a "restricted" tag rather than a zero — a
 * missing price and a price of zero mean very different things.
 */
export function ProductsScreen({ navigation }: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t } = useI18n();
  const { business, can } = useAuth();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');

  const currency = business?.currency ?? 'BDT';
  const showCost = can('purchase.cost.view');

  const loader = useCallback(() => localProducts({ search, ...(filter === 'ALL' ? {} : { kind: filter }) }), [search, filter]);
  const { data, loading, reload } = useAsyncData(loader, [loader]);
  useReloadOnFocus(reload);

  return (
    <Screen
      title={t('products.title')}
      onRefresh={reload}
      refreshing={loading}
      footer={
        can('product.manage') ? (
          <View style={{ marginTop: spacing.lg }}>
            <Button label={t('products.new')} onPress={() => navigation.navigate('ProductEdit', {})} fullWidth />
          </View>
        ) : null
      }
    >
      <Field label={t('common.search')} value={search} onChangeText={setSearch} autoCapitalize="none" />
      <Segmented
        options={[
          { value: 'ALL' as Filter, label: t('common.all') },
          { value: 'PRODUCT' as Filter, label: t('nav.products') },
          { value: 'INPUT' as Filter, label: 'Input' },
          { value: 'OUTPUT' as Filter, label: 'Output' },
          { value: 'LIVESTOCK' as Filter, label: 'Livestock' },
        ]}
        value={filter}
        onChange={setFilter}
      />

      {!showCost ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}

      <Card>
        {data && data.length > 0 ? (
          data.map((product) => (
            <ListRow
              key={product.id}
              title={product.name}
              subtitle={product.nameBn ?? product.sku ?? product.kind}
              badge={product.kind !== 'PRODUCT' ? <Tag text={product.kind} /> : undefined}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <MoneyText value={product.salePrice ?? '0'} currency={currency} />
                  <QuantityText value={product.onHand} unit={product.unit} />
                  {showCost && product.purchasePrice != null ? (
                    <Text style={[typography.caption, { color: colors.textMuted }]}>
                      {t('products.purchasePrice')} {product.purchasePrice}
                    </Text>
                  ) : null}
                </View>
              }
              onPress={() => navigation.navigate('ProductEdit', { productId: product.id })}
            />
          ))
        ) : (
          <EmptyState title={t('common.none')} body={t('offline.coreWorksOffline')} />
        )}
      </Card>
    </Screen>
  );
}
