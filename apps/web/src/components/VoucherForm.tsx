import { useMemo, useState, type ReactNode } from 'react';
import type { MessageKey } from '../i18n';
import type { CacheStore } from '../offline/db';
import { ApiError } from '../api/client';
import { deviceId, newLocalId, saveLocally } from '../offline/localStorage';
import { useOnline } from '../offline/useSync';
import { useApp, useT } from '../state/AppContext';
import { Button, Card, CheckboxInput, Notice, SelectInput, TextAreaInput, TextInput, type SelectOption } from './ui';

/**
 * One voucher form, driven by a spec.
 *
 * Receipts, payments, transfers, income/expenses and partner capital differ only
 * in their fields, their endpoint and — when offline — the outbox event type.
 * Keeping that in a spec means the offline behaviour is implemented once and is
 * therefore identical for all five.
 */

export type VoucherValue = string | boolean;
export type VoucherValues = Readonly<Record<string, VoucherValue>>;

export interface VoucherFieldSpec {
  readonly name: string;
  readonly labelKey: MessageKey;
  readonly kind: 'date' | 'money' | 'text' | 'textarea' | 'select' | 'checkbox';
  readonly required?: boolean;
  readonly hintKey?: MessageKey;
  readonly defaultValue?: string;
  /** `checkbox` only: whether it starts ticked. */
  readonly defaultChecked?: boolean;
  /** `select` fields need an option list (usually from a query). */
  readonly optionKey?: string;
}

export interface VoucherOfflineSpec {
  readonly eventType: string;
  readonly store: CacheStore;
  readonly toPayload: (values: VoucherValues) => Record<string, unknown>;
  readonly toRecord: (values: VoucherValues, localId: string, payload: Record<string, unknown>) => Record<string, unknown>;
}

export interface VoucherSpec {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly fields: readonly VoucherFieldSpec[];
  /** Called when ONLINE. Must use the real API endpoint. */
  readonly submit: (values: VoucherValues) => Promise<unknown>;
  /** How to queue the same voucher on the device when offline. */
  readonly offline?: VoucherOfflineSpec;
  /** Renders the server's response for the user. */
  readonly renderResult?: (result: Record<string, unknown>) => ReactNode;
  readonly submitLabelKey?: MessageKey;
}

export function VoucherForm({
  spec,
  options,
  onPosted,
}: {
  readonly spec: VoucherSpec;
  readonly options: Readonly<Record<string, readonly SelectOption[]>>;
  readonly onPosted?: () => void;
}) {
  const { t } = useT();
  const { business, me, notify } = useApp();
  const online = useOnline();
  const initial = useMemo(() => {
    const values: Record<string, VoucherValue> = {};
    for (const field of spec.fields) {
      values[field.name] = field.kind === 'checkbox' ? field.defaultChecked === true : field.defaultValue ?? (field.kind === 'date' ? new Date().toISOString().slice(0, 10) : '');
    }
    return values;
  }, [spec]);

  const [values, setValues] = useState<Record<string, VoucherValue>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, value: VoucherValue) => setValues((current) => ({ ...current, [name]: value }));

  const submit = () => {
    setError(null);
    setResult(null);
    for (const field of spec.fields) {
      if (!field.required) continue;
      const value = values[field.name];
      if (value === undefined || value === '' || value === false) {
        setError(`${t('common.requiredFields')} (${t(field.labelKey)})`);
        return;
      }
    }
    setBusy(true);
    void (async () => {
      try {
        if (online) {
          const response = await spec.submit(values);
          setResult(typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : { ok: true });
          notify(t('fin.posted'), 'success');
        } else {
          if (!spec.offline || !business || !me) throw new Error(t('sync.unsupported'));
          const localId = newLocalId();
          const payload = spec.offline.toPayload(values);
          await saveLocally(
            {
              eventType: spec.offline.eventType,
              aggregateId: localId,
              payload,
              store: spec.offline.store,
              record: spec.offline.toRecord(values, localId, payload),
            },
            { businessId: business.id, actorId: me.user.id, deviceId: deviceId() },
          );
          setResult({ queued: true });
          notify(t('common.savedOffline'), 'warn');
        }
        setValues(initial);
        onPosted?.();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Card
      title={t(spec.titleKey)}
      subtitle={online ? undefined : t('common.offline')}
      actions={
        <Button variant="primary" onClick={submit} disabled={busy}>
          {t(spec.submitLabelKey ?? 'common.save')}
        </Button>
      }
    >
      {error ? <Notice level="error">{error}</Notice> : null}
      {result ? (
        result.queued === true ? (
          <Notice level="warn">{t('common.savedOffline')}</Notice>
        ) : spec.renderResult ? (
          spec.renderResult(result)
        ) : (
          <Notice level="success">{t('fin.posted')}</Notice>
        )
      ) : null}

      <div className="grid grid--2">
        {spec.fields.map((field) => {
          const value = values[field.name];
          const text = typeof value === 'string' ? value : '';
          if (field.kind === 'checkbox') {
            return <CheckboxInput key={field.name} label={t(field.labelKey)} checked={value === true} onCheckedChange={(checked) => set(field.name, checked)} {...(field.hintKey ? { hint: t(field.hintKey) } : {})} />;
          }
          if (field.kind === 'select') {
            return (
              <SelectInput
                key={field.name}
                label={t(field.labelKey)}
                value={text}
                onValueChange={(next) => set(field.name, next)}
                options={field.optionKey ? options[field.optionKey] ?? [] : []}
                placeholder={t(field.labelKey)}
                {...(field.required ? { required: true } : {})}
                {...(field.hintKey ? { hint: t(field.hintKey) } : {})}
              />
            );
          }
          if (field.kind === 'textarea') {
            return <TextAreaInput key={field.name} label={t(field.labelKey)} value={text} onValueChange={(next) => set(field.name, next)} {...(field.required ? { required: true } : {})} />;
          }
          return (
            <TextInput
              key={field.name}
              label={t(field.labelKey)}
              value={text}
              onValueChange={(next) => set(field.name, next)}
              type={field.kind === 'date' ? 'date' : 'text'}
              {...(field.kind === 'money' ? { inputMode: 'decimal' as const } : {})}
              {...(field.required ? { required: true } : {})}
              {...(field.hintKey ? { hint: t(field.hintKey) } : {})}
            />
          );
        })}
      </div>
    </Card>
  );
}
