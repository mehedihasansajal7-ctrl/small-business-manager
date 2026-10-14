/**
 * Runtime polyfills, installed before anything else (see index.ts).
 *
 * `@sbm/domain` is deliberately dependency-free and uses three Web platform
 * globals:
 *   - `TextEncoder`              → sha256Hex(payload) for outbox idempotency keys
 *   - `crypto.getRandomValues`   → invite codes / random bytes
 *   - `crypto.randomUUID`        → outbox `eventId` (also the server's idempotency key)
 *
 * Hermes does not provide all of these on all Android versions, and an outbox
 * event that cannot be created is a lost business transaction, so we install
 * explicit fallbacks rather than hoping.
 *
 * Nothing here is cryptography-critical on the device: the server recomputes
 * every hash and owns all real secrets. These globals only need to be
 * *deterministic* and *unique enough* to keep the outbox consistent.
 */
import { getRandomBytes, randomUUID } from 'expo-crypto';

type MutableGlobal = typeof globalThis & {
  TextEncoder?: unknown;
  crypto?: {
    randomUUID?: () => string;
    getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
  };
};

const globals = globalThis as MutableGlobal;

// ---------------------------------------------------------------------------
// TextEncoder — only the UTF-8 encode path the domain package uses.
// ---------------------------------------------------------------------------

class Utf8TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const text = String(input);
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      // Combine a surrogate pair into a single code point.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
          i += 1;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }

  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    const encoded = this.encode(input);
    const written = Math.min(encoded.length, destination.length);
    destination.set(encoded.subarray(0, written));
    return { read: input.length, written };
  }
}

if (typeof globals.TextEncoder === 'undefined') {
  globals.TextEncoder = Utf8TextEncoder;
}

// ---------------------------------------------------------------------------
// crypto.getRandomValues / crypto.randomUUID
// ---------------------------------------------------------------------------

const cryptoObject = globals.crypto ?? {};
globals.crypto = cryptoObject;

if (typeof cryptoObject.getRandomValues !== 'function') {
  cryptoObject.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (!array) return array;
    const view = array as unknown as { byteLength: number; length?: number };
    const buffer = new Uint8Array(getRandomBytes(view.byteLength));
    // Copy into the caller's view (Uint8Array / Int32Array / DataView…).
    new Uint8Array((array as unknown as ArrayBufferView).buffer).set(buffer);
    return array;
  };
}

if (typeof cryptoObject.randomUUID !== 'function') {
  cryptoObject.randomUUID = (): string => {
    // expo-crypto's randomUUID is the platform implementation; the manual
    // fallback exists only so a stripped-down build cannot crash the outbox.
    try {
      return randomUUID();
    } catch {
      const bytes = getRandomBytes(16);
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  };
}

export {};
