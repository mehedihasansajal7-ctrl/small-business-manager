import { StyleSheet, Text, View } from 'react-native';

import type { AIMode as AIModeType } from '../api/types';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

/**
 * The AI mode badge.
 *
 * The spec is uncompromising here: a user must always be able to tell whether an
 * answer came from a generative model, a model running on their own machine, or
 * the built-in deterministic rule engine. So the badge never says just "AI" — it
 * spells out the mode and names the provider, and the fallback state is worded as
 * plainly as possible.
 */
export function AIModeBadge({ mode, provider }: { mode: AIModeType; provider: string }) {
  const { colors, radius, spacing, typography, scheme } = useTheme();
  const { t } = useI18n();

  const label =
    mode === 'generative' ? t('ai.modeGenerative') : mode === 'local' ? t('ai.modeLocal') : t('ai.modeFallback');

  const palette =
    mode === 'fallback'
      ? { background: colors.warningMuted, text: colors.warning, border: colors.warning }
      : mode === 'local'
        ? { background: colors.infoMuted, text: colors.info, border: colors.info }
        : { background: colors.successMuted, text: colors.success, border: colors.success };

  void scheme;

  return (
    <View
      style={{
        backgroundColor: palette.background,
        borderColor: palette.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.md,
        gap: 2,
      }}
    >
      <Text style={[typography.label, { color: palette.text }]}>
        {t('ai.mode')}: {mode.toUpperCase()}
      </Text>
      <Text style={[typography.caption, { color: palette.text }]}>{label}</Text>
      <Text style={[typography.caption, { color: palette.text, opacity: 0.85 }]}>provider: {provider}</Text>
    </View>
  );
}
