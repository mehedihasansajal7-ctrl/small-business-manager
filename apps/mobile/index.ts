/**
 * Expo entry point.
 *
 * `react-native-gesture-handler` must be imported before anything that renders
 * (the drawer navigator depends on it), and the polyfills must be installed before
 * any `@sbm/domain` code runs, because the domain package computes SHA-256 payload
 * hashes with `TextEncoder` and creates outbox ids with `crypto.randomUUID`.
 * Hermes ships neither on every device, so we install deterministic fallbacks here.
 */
import 'react-native-gesture-handler';
import './src/polyfills';
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
