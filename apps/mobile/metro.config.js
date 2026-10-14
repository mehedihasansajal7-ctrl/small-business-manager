const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro config.
 *
 * `apps/mobile` is deliberately NOT a member of the root npm workspace (the
 * Expo dependency tree is large, so installing it is an explicit choice). It
 * still consumes the shared, framework-free `@sbm/domain` package, which lives
 * two directories up and is installed through a `file:` dependency:
 *
 *   "dependencies": { "@sbm/domain": "file:../../packages/domain" }
 *
 * Because that dependency is a symlink/junction outside the app folder, Metro
 * must be told about the monorepo root, and the resolver must be able to fall
 * back to the root `node_modules`.
 *
 * The package is consumed from its compiled `dist/` (see packages/domain —
 * `npm run build`), so Metro never has to transpile another package's sources.
 */
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

// Watch the domain package (and the rest of the monorepo) for changes.
config.watchFolders = [monorepoRoot];

// Resolve modules from the app first, then the monorepo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// The domain package is plain ESM JS in `dist/`; add its build output as an
// explicit fallback so a hoisting change can never break the import.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@sbm/domain': path.resolve(monorepoRoot, 'packages', 'domain'),
};

// expo-sqlite, expo-secure-store and expo-image-picker ship native code and are
// resolved from the app's own node_modules.
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs'];

module.exports = config;
