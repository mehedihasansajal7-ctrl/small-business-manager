module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // babel-preset-expo covers React Native, JSX, TypeScript, the Expo module
      // runtime and (when react-native-reanimated is installed) the worklet
      // plugin, so no extra preset or plugin is required here.
      'babel-preset-expo',
    ],
  };
};
