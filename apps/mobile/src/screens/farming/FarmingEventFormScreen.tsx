import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';

import { STANDARD_ACCOUNTS, dec, localDateString } from '@sbm/domain';

import { useAuth } from '../../auth/AuthProvider';
import { useActor } from '../../auth/useActor';
import { Button, Card, Field, Notice, NumberInput, OfflineCapabilityNote, Screen, SectionTitle, Select } from '../../components';
import { localProducts, recordFarmingCost, recordInputIssue, recordMortality, recordObservation } from '../../offline/repository';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useSync } from '../../lib/useSync';
import { useTheme } from '../../theme';
import type { FarmingStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<FarmingStackParamList, 'FarmingEventForm'>;

/**
 * Direct-cost events the server accepts, and the expense account it defaults to.
 *
 * `WASTE` is deliberately **not** in this list: the server routes
 * `MORTALITY` and `WASTE` through the same loss branch, which requires a positive
 * quantity, a unit and a reason ≥ 3 characters. Submitting it as a plain cost
 * would come back `REJECTED`, so the form treats it as a loss instead.
 */
const COST_EVENTS: readonly { readonly eventType: string; readonly defaultAccount: string }[] = [
  { eventType: 'DIRECT_LABOUR', defaultAccount: '5110' },
  { eventType: 'MACHINERY_FUEL', defaultAccount: '5140' },
  { eventType: 'VETERINARY', defaultAccount: '5150' },
  { eventType: 'UTILITIES', defaultAccount: '5120' },
  { eventType: 'PACKAGING', defaultAccount: '5180' },
  { eventType: 'TRANSPORT', defaultAccount: '5130' },
  { eventType: 'OVERHEAD', defaultAccount: '5100' },
];

/**
 * Record a farming operation on a cycle.
 *
 * One form for four very different shapes, because that is what the server
 * accepts: an **input issue** moves real inventory out of the store, a **direct
 * cost** posts to the ledger, an **observation** records a note (no money), and a
 * **mortality** loss may carry a book value that posts to
 * `5400 Mortality & Production Loss`.
 *
 * The >= 25 unit escalation rule is applied locally as well (via `Decimal.gte`) so
 * the warning is shown before the user saves, not after a round trip.
 */
export function FarmingEventFormScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const { business } = useAuth();
  const actor = useActor();
  const { online } = useNetwork();
  const { syncNow } = useSync();
  const { colors, typography, spacing } = useTheme();

  const { cycleId, eventType, title } = route.params;
  const currency = business?.currency ?? 'BDT';
  const timezone = business?.timezone ?? 'Asia/Dhaka';

  const [occurredOn, setOccurredOn] = useState(localDateString(new Date(), timezone));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // input issue
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('0');
  const [unit, setUnit] = useState('kg');

  // cost / mortality
  const [amount, setAmount] = useState('0');
  const [accountCode, setAccountCode] = useState(COST_EVENTS.find((entry) => entry.eventType === eventType)?.defaultAccount ?? '5100');
  const [paymentAccount, setPaymentAccount] = useState('1000');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  // observation
  const [kind, setKind] = useState('');
  const [value, setValue] = useState('');

  const isInputIssue = eventType === 'INPUT_ISSUE';
  const isObservation = eventType === 'OBSERVATION';
  const isMutationLoss = eventType === 'MORTALITY' || eventType === 'WASTE';

  const productsLoader = useCallback(() => localProducts(isInputIssue ? { kind: 'INPUT' } : {}), [isInputIssue]);
  const { data: products } = useAsyncData(productsLoader, [productsLoader]);

  const abnormal = isMutationLoss && dec(quantity).gte(dec('25'));

  const accountOptions = useMemo(
    () =>
      STANDARD_ACCOUNTS.filter((account) => account.type === 'EXPENSE' && !account.contra).map((account) => ({
        value: account.code,
        label: `${account.code} — ${account.name}`,
      })),
    [],
  );

  const submit = async () => {
    setError(null);
    if (!actor) return;
    setBusy(true);
    try {
      if (isObservation) {
        if (kind.trim().length < 2) {
          setError(t('common.required'));
          return;
        }
        await recordObservation(actor, { cycleId, occurredOn, kind: kind.trim(), value, unit, notes: notes.trim() || undefined });
      } else if (isInputIssue) {
        if (!productId || !dec(quantity).isPositive()) {
          setError(t('common.quantity'));
          return;
        }
        await recordInputIssue(actor, { cycleId, occurredOn, productId, quantity, unit, currency, notes: notes.trim() || undefined });
      } else if (isMutationLoss) {
        if (!dec(quantity).isPositive() || reason.trim().length < 3) {
          setError(t('farming.mortality'));
          return;
        }
        await recordMortality(actor, { cycleId, occurredOn, currency, quantity, unit, reason: reason.trim(), bookValue: amount, notes: notes.trim() || undefined });
      } else {
        if (!dec(amount).isPositive()) {
          setError(t('common.amount'));
          return;
        }
        await recordFarmingCost(actor, {
          cycleId,
          eventType,
          occurredOn,
          currency,
          amount,
          accountCode,
          paymentAccount,
          quantity,
          unit,
          notes: notes.trim() || undefined,
        });
      }
      if (online) void syncNow();
      navigation.goBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={title} subtitle={business?.name}>
      {!online ? <OfflineCapabilityNote /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}
      {abnormal ? <Notice tone="danger" title={t('farming.mortalityWarning')} body={t('farming.mortalityEscalation')} /> : null}

      <Card>
        <Field label={t('common.date')} value={occurredOn} onChangeText={setOccurredOn} note="YYYY-MM-DD" required />

        {isObservation ? (
          <>
            <Field label={t('common.type')} value={kind} onChangeText={setKind} required note="e.g. plant height, pest seen, temperature" />
            <Field label={t('common.description')} value={value} onChangeText={setValue} />
            <Field label={t('common.unit')} value={unit} onChangeText={setUnit} />
          </>
        ) : null}

        {isInputIssue ? (
          <>
            <Select
              label={t('common.product')}
              value={productId}
              options={[{ value: '', label: t('common.noneSelected') }, ...(products ?? []).map((product) => ({ value: product.id, label: `${product.name} (${product.unit})` }))]}
              onChange={(value) => {
                setProductId(value);
                const product = (products ?? []).find((entry) => entry.id === value);
                if (product) setUnit(product.unit);
              }}
              required
              note={(products ?? []).length === 0 ? t('products.title') + ': ' + t('common.none') : undefined}
            />
            <NumberInput label={t('common.quantity')} value={quantity} onChange={(next) => setQuantity(next ?? '0')} mode="quantity" required />
            <Field label={t('common.unit')} value={unit} onChangeText={setUnit} />
          </>
        ) : null}

        {isMutationLoss ? (
          <>
            <NumberInput label={t('common.quantity')} value={quantity} onChange={(next) => setQuantity(next ?? '0')} mode="quantity" required />
            <Field label={t('common.unit')} value={unit} onChangeText={setUnit} required />
            <Field label={t('inventory.reason')} value={reason} onChangeText={setReason} required multiline />
            <NumberInput label={t('common.cost')} value={amount} onChange={(next) => setAmount(next ?? '0')} mode="money" currency={currency} note={t('common.optional')} />
          </>
        ) : null}

        {!isInputIssue && !isObservation && !isMutationLoss ? (
          <>
            <NumberInput label={t('common.amount')} value={amount} onChange={(next) => setAmount(next ?? '0')} mode="money" currency={currency} required />
            <Select label={t('common.category')} value={accountCode} options={accountOptions} onChange={setAccountCode} />
            <Select
              label={t('common.account')}
              value={paymentAccount}
              options={STANDARD_ACCOUNTS.filter((account) => ['1000', '1010', '1020'].includes(account.code)).map((account) => ({ value: account.code, label: `${account.code} — ${account.name}` }))}
              onChange={setPaymentAccount}
            />
            <NumberInput label={t('common.quantity')} value={quantity} onChange={(next) => setQuantity(next ?? '0')} mode="quantity" note={t('common.optional')} />
          </>
        ) : null}

        <Field label={t('common.notes')} value={notes} onChangeText={setNotes} multiline />
      </Card>

      <SectionTitle title={t('farming.cycleDetail')} />
      <Button label={t('common.save')} onPress={() => void submit()} loading={busy} fullWidth />
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: spacing.md }]}>{t('offline.coreWorksOffline')}</Text>
      <Text style={[typography.caption, { color: colors.textMuted }]}>{cycleId} • {eventType}</Text>
    </Screen>
  );
}
