import { Text, type StyleProp, type TextStyle } from 'react-native';

import { useI18n } from '../i18n';
import { useTheme } from '../theme';

/**
 * Money display.
 *
 * Every figure in the app goes through here, which means every figure is parsed
 * and formatted by `@sbm/domain` (`formatMoney` + `money`) with Bangla digits and
 * South-Asian lakh/crore grouping when Bangla is selected. There is no
 * `toLocaleString` and no float arithmetic anywhere in the display path.
 */
export function MoneyText({
  value,
  currency,
  style,
  tone,
}: {
  value: string | number | null | undefined;
  currency: string;
  style?: StyleProp<TextStyle>;
  tone?: 'default' | 'positive' | 'negative';
}) {
  const { colors, typography } = useTheme();
  const { money } = useI18n();
  const isNegative = typeof value === 'string' ? value.trim().startsWith('-') : typeof value === 'number' ? value < 0 : false;

  const color = tone === 'positive' ? colors.success : tone === 'negative' || isNegative ? colors.danger : colors.text;

  return (
    <Text style={[typography.mono, { color }, style]} numberOfLines={1} adjustsFontSizeToFit>
      {money(value, currency)}
    </Text>
  );
}

/**
 * Quantity display (no currency). Uses the same Bangla-digit decision as money
 * but keeps the exact stored scale of the decimal.
 */
export function QuantityText({ value, unit, style }: { value: string | number | null | undefined; unit?: string; style?: StyleProp<TextStyle> }) {
  const { colors, typography } = useTheme();
  const { quantity } = useI18n();
  const text = quantity(value);
  return (
    <Text style={[typography.mono, { color: colors.text }, style]} numberOfLines={1}>
      {text}
      {unit ? ` ${unit}` : ''}
    </Text>
  );
}
