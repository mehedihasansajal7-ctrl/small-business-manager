import { EncodingType, readAsStringAsync } from 'expo-file-system';

import { uploadAttachment } from '../api/endpoints';
import { isOfflineError } from '../api/client';
import { all, run, withTransaction } from './db';

/**
 * Photo attachments.
 *
 * **Why this is a separate queue and NOT part of the outbox.**
 *
 * A receipt photo is evidence *about* a business transaction, not part of it.
 * If the upload were bundled into the sale's sync event, a flaky connection (or
 * a 5 MB rejection at the edge) would either roll the sale back or make the
 * whole sale retry — and retrying an upload that already succeeded would attach
 * the photo twice. The server's own route makes this explicit:
 *
 *     "Attachments are stored on this server and are NOT shared with partners
 *      who are offline."
 *
 * So the rules are:
 *  1. the business transaction is queued first, wins its own idempotency key and
 *     is never rolled back by an attachment failure;
 *  2. the photo is queued here, retried independently, and can be attached to a
 *     record that has not synced yet (the entity id is the *client* id, and the
 *     server accepts any entity id string);
 *  3. the UI always says the image is "stored on your server, partners see it
 *     after syncing" — never "shared".
 */

export interface QueuedAttachment {
  id: string;
  business_id: string;
  entity_type: string;
  entity_id: string;
  local_uri: string;
  file_name: string;
  mime: string;
  size_bytes: number | null;
  status: 'PENDING' | 'UPLOADED' | 'FAILED';
  attempts: number;
  last_error: string | null;
  created_at: string;
  uploaded_at: string | null;
}

export interface NewAttachment {
  readonly businessId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly localUri: string;
  readonly fileName: string;
  readonly mime: string;
  readonly sizeBytes?: number;
}

/** Enqueue a photo. Never throws into the caller's business transaction. */
export async function queueAttachment(input: NewAttachment): Promise<QueuedAttachment> {
  const record: QueuedAttachment = {
    id: globalThis.crypto.randomUUID(),
    business_id: input.businessId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    local_uri: input.localUri,
    // `safeFileName` on the server strips path separators again; do a light pass
    // here so the query string we build is already clean.
    file_name: input.fileName.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120) || 'photo.jpg',
    mime: input.mime,
    size_bytes: input.sizeBytes ?? null,
    status: 'PENDING',
    attempts: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    uploaded_at: null,
  };

  await withTransaction(async (tx) => {
    await tx.runAsync(
      `INSERT INTO attachment_queue (id, business_id, entity_type, entity_id, local_uri, file_name, mime, size_bytes, status, attempts, last_error, created_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, ?, NULL)`,
      [record.id, record.business_id, record.entity_type, record.entity_id, record.local_uri, record.file_name, record.mime, record.size_bytes, record.created_at],
    );
  });

  return record;
}

export async function attachmentsFor(entityType: string, entityId: string): Promise<QueuedAttachment[]> {
  return all<QueuedAttachment>('SELECT * FROM attachment_queue WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [entityType, entityId]);
}

export async function pendingAttachmentCount(businessId: string): Promise<number> {
  const rows = await all<{ count: number }>(`SELECT COUNT(*) AS count FROM attachment_queue WHERE business_id = ? AND status != 'UPLOADED'`, [businessId]);
  return rows[0]?.count ?? 0;
}

export interface AttachmentFlushResult {
  readonly uploaded: number;
  readonly failed: number;
  readonly pending: number;
  readonly offline: boolean;
  readonly message: string | null;
}

/**
 * Try to upload every queued photo. Failures are recorded and retried later; the
 * function never throws for a network problem.
 */
export async function flushAttachments(businessId: string, limit = 10): Promise<AttachmentFlushResult> {
  const queue = await all<QueuedAttachment>(
    `SELECT * FROM attachment_queue WHERE business_id = ? AND status != 'UPLOADED' ORDER BY created_at LIMIT ?`,
    [businessId, limit],
  );

  let uploaded = 0;
  let failed = 0;
  let offline = false;
  let message: string | null = null;

  for (const item of queue) {
    try {
      const base64 = await readAsStringAsync(item.local_uri, { encoding: EncodingType.Base64 });
      const bytes = base64ToBytes(base64);
      await uploadAttachment(item.entity_type, item.entity_id, bytes, item.file_name, item.mime);
      await run(`UPDATE attachment_queue SET status = 'UPLOADED', uploaded_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?`, [
        new Date().toISOString(),
        item.id,
      ]);
      uploaded += 1;
    } catch (error) {
      // A missing local file is permanent; anything else is retried later.
      const isMissingFile = error instanceof Error && /no such file|does not exist|ENOENT/i.test(error.message);
      const offlineError = isOfflineError(error);
      offline = offline || offlineError;
      if (!offlineError) failed += 1;
      message = message ?? (error instanceof Error ? error.message : 'Upload failed');
      await run(`UPDATE attachment_queue SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`, [
        isMissingFile ? 'FAILED' : item.status,
        error instanceof Error ? error.message : 'Upload failed',
        item.id,
      ]);
    }
  }

  const remaining = await pendingAttachmentCount(businessId);
  return { uploaded, failed, pending: remaining, offline, message };
}

/**
 * Base64 → bytes without `Buffer` (not available on Hermes) or `atob`
 * (present on modern Hermes, but we must not depend on it for a correctness
 * path). A plain lookup table is fast enough for a few hundred kilobytes.
 */
function base64ToBytes(base64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) lookup[alphabet.charCodeAt(i)] = i;

  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const value = lookup[clean.charCodeAt(i)] ?? -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return output.subarray(0, outIndex);
}

/**
 * The wording every photo control must show. Kept here so no screen can
 * accidentally promise partner visibility before a sync happens.
 */
export const ATTACHMENT_NOTICE = {
  en: 'Photos are stored on your server. Partners see them after syncing.',
  bn: 'ছবিগুলো আপনার সার্ভারে সংরক্ষিত হয়। সিঙ্ক হওয়ার পর অংশীদাররা দেখতে পাবেন।',
} as const;
