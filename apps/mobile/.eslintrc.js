/**
 * ESLint configuration (eslintrc format — the format Expo SDK 52 projects use).
 *
 * `eslint-config-expo` composes the React, React Hooks, React Native and
 * TypeScript rule sets Expo recommends, so this app is linted with the same
 * baseline as a freshly created Expo project.
 */
module.exports = {
  extends: 'expo',
  ignorePatterns: ['node_modules/', 'android/', 'ios/', '.expo/', 'dist/'],
  rules: {
    // `useAsyncData(loader, deps)` forwards its dependency array to `useCallback`
    // on purpose — the hook's contract is "these values decide when to reload".
    'react-hooks/exhaustive-deps': 'warn',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
};
