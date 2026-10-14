/**
 * Expo entry point.
 *
 * The polyfills MUST be imported before anything that touches `@sbm/domain`,
 * because the domain package computes SHA-256 payload hashes with `TextEncoder`
 * and creates outbox ids with `crypto.randomUUID`. Hermes ships neither on every
 * device, so we install deterministic fallbacks first (see src/polyfills).
 */
import './src/polyfills';
import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
