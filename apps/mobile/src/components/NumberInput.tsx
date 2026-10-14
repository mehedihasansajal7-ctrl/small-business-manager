import { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import { Decimal, dec, money, normalizeDecimalInput, toBanglaDigits } from '@sbm/domain';

import { useI18n } from '../i18n';
import { useTheme } from '../theme';

/**
 * Exact-decimal input for money and quantities.
 *
 * **`Number()` is never used here.** Every keystroke is cleaned by the shared
 * `normalizeDecimalInput` and parsed by `Decimal.fromString`, so `0.1 + 0.2` is
 * still `0.3`, `12345678901234567890.55` does not lose digits, and a typo like
 * `12,,3` is rejected instead of silently becoming `12`.
 *
 * The component keeps the raw text while focused (so a user can type "1." and
 * keep going) and only canonicalises on blur:
 *   - money      → `58.00` (rounded to the currency's minor unit by `money()`)
 *   - quantity   → `58.5`  (the decimal's own scale, no rounding)
 *
 * Bangla digits are accepted as input as well as displayed.
 */

export type NumberMode = 'money' | 'quantity';

export interface NumberInputProps {
  readonly label: string;
  /** Exact decimal string, e.g. from the API or a previous save. */
  readonly value: string;
  /** Receives the canonical exact string, or `null` while the text is invalid. */
  readonly onChange: (value: string | null) => void;
  readonly mode?: NumberMode;
  readonly currency?: string;
  readonly placeholder?: string;
  readonly note?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
  /** Show the computed money value under the field (POS line totals). */
  readonly preview?: string | null;
}

function canonicalize(text: string, mode: NumberMode, currency: string): string | null {
  if (text.trim() === '') return mode === 'money' ? money(currency, '0').amount.toString() : dec('0').toString();
  try {
    const normalized = normalizeDecimalInput(text);
    const parsed = Decimal.fromString(normalized);
    if (mode === 'money') return money(currency, parsed).amount.toString();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function NumberInput({ label, value, onChange, mode = 'money', currency = 'BDT', placeholder, note, required, disabled, testID, preview }: NumberInputProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const { language } = useI18n();
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Only follow the parent while the field is not being edited, so a sync pull
  // cannot overwrite what the user is typing.
  const display = dirty ? text : value;

  const keyboardType: KeyboardTypeOptions = 'decimal-pad';

  const handleChange = (next: string) => {
    setDirty(true);
    setText(next);
    const canonical = canonicalize(next, mode, currency);
    setInvalid(canonical === null);
    onChange(canonical);
  };

  const handleBlur = () => {
    const canonical = canonicalize(text, mode, currency);
    setDirty(false);
    setInvalid(false);
    if (canonical !== null) {
      setText(canonical);
      onChange(canonical);
    }
  };

  const banglaDigits = language === 'bn';
  const shown = banglaDigits && !dirty ? toBanglaDigits(display) : display;

  const unitHint = useMemo(() => (mode === 'money' ? currency : null), [mode, currency]);

  return (
    <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
      <Text style={[typography.label, { color: colors.textMuted }]}>
        {label}
        {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
        {unitHint ? <Text> ({unitHint})</Text> : null}
      </Text>
      <TextInput
        testID={testID}
        value={shown}
        onChangeText={handleChange}
        onBlur={handleBlur}
        keyboardType={keyboardType}
        inputMode="decimal"
        placeholder={placeholder ?? (mode === 'money' ? '0.00' : '0')}
        placeholderTextColor={colors.textMuted}
        editable={!disabled}
        style={[
          typography.mono,
          {
            color: colors.text,
            backgroundColor: disabled ? colors.surfaceAlt : colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: invalid ? colors.danger : colors.border,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.md,
            minHeight: 46,
          },
        ]}
      />
      {invalid ? (
        <Text style={[typography.caption, { color: colors.danger }]}>Enter a valid number (digits, one decimal point).</Text>
      ) : preview ? (
        <Text style={[typography.caption, { color: colors.textMuted }]}>= {preview}</Text>
      ) : note ? (
        <Text style={[typography.caption, { color: colors.textMuted }]}>{note}</Text>
      ) : null}
    </View>
  );
}

/**
 * Export the canonicalising helper so POS forms can compute a total from typed
 * text without ever touching `Number()`.
 */
export function toExactAmount(text: string, mode: NumberMode = 'money', currency = 'BDT'): string | null {
  return canonicalize(text, mode, currency);
}
