import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { useState } from 'react';

import { useTheme } from '../theme';

/**
 * Form fields.
 *
 * `Field` is a labelled text input with inline validation text; `Select` opens a
 * modal list, which is the only picker that behaves identically on every Android
 * version (the platform `Picker` is inconsistent and `@react-native-picker`
 * adds a native dependency for something the modal does well enough).
 */

export interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder?: string;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly multiline?: boolean;
  readonly note?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  readonly secureTextEntry?: boolean;
  readonly editable?: boolean;
  readonly testID?: string;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  note,
  error,
  required,
  autoCapitalize = 'sentences',
  secureTextEntry,
  editable = true,
  testID,
}: FieldProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
      <Text style={[typography.label, { color: colors.textMuted }]}>
        {label}
        {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
      </Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        editable={editable}
        style={[
          typography.body,
          {
            color: colors.text,
            backgroundColor: editable ? colors.surface : colors.surfaceAlt,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: error ? colors.danger : focused ? colors.primary : colors.border,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.md,
            minHeight: multiline ? 88 : 46,
            textAlignVertical: multiline ? 'top' : 'center',
          },
        ]}
      />
      {error ? (
        <Text style={[typography.caption, { color: colors.danger }]}>{error}</Text>
      ) : note ? (
        <Text style={[typography.caption, { color: colors.textMuted }]}>{note}</Text>
      ) : null}
    </View>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly note?: string;
}

export interface SelectProps {
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly note?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function Select({ label, value, options, onChange, placeholder, note, error, required, disabled, testID }: SelectProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
      <Text style={[typography.label, { color: colors.textMuted }]}>
        {label}
        {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
      </Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: error ? colors.danger : colors.border,
          borderRadius: radius.md,
          backgroundColor: disabled ? colors.surfaceAlt : colors.surface,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.md,
          minHeight: 46,
          justifyContent: 'center',
        }}
      >
        <Text style={[typography.body, { color: selected ? colors.text : colors.textMuted }]} numberOfLines={1}>
          {selected?.label ?? placeholder ?? '—'}
        </Text>
      </Pressable>
      {error ? (
        <Text style={[typography.caption, { color: colors.danger }]}>{error}</Text>
      ) : note ? (
        <Text style={[typography.caption, { color: colors.textMuted }]}>{note}</Text>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: spacing.lg }} onPress={() => setOpen(false)}>
          <Pressable
            style={{
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              maxHeight: '75%',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
            }}
            onPress={() => undefined}
          >
            <Text style={[typography.subheading, { color: colors.text, padding: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              {label}
            </Text>
            <ScrollView>
              {options.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={({ pressed }) => ({
                    padding: spacing.lg,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                    backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                  })}
                >
                  <Text style={[typography.body, { color: option.value === value ? colors.primary : colors.text }]}>{option.label}</Text>
                  {option.note ? <Text style={[typography.caption, { color: colors.textMuted }]}>{option.note}</Text> : null}
                </Pressable>
              ))}
              {options.length === 0 ? (
                <Text style={[typography.body, { color: colors.textMuted, padding: spacing.lg }]}>—</Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

export function Toggle({ label, value, onChange, note, disabled }: { label: string; value: boolean; onChange: (value: boolean) => void; note?: string; disabled?: boolean }) {
  const { colors, radius, spacing, typography } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, opacity: disabled ? 0.5 : 1 }}
    >
      <View
        style={{
          width: 46,
          height: 28,
          borderRadius: radius.pill,
          backgroundColor: value ? colors.primary : colors.border,
          justifyContent: 'center',
          paddingHorizontal: 3,
        }}
      >
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#ffffff', alignSelf: value ? 'flex-end' : 'flex-start' }} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[typography.body, { color: colors.text }]}>{label}</Text>
        {note ? <Text style={[typography.caption, { color: colors.textMuted }]}>{note}</Text> : null}
      </View>
    </Pressable>
  );
}
