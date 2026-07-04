/**
 * @file Netlify Blobs storage layer for widget tokens.
 *
 * ## Blob store layout (`widget-tokens`)
 *
 * | Key                   | Value                        | Purpose                       |
 * |-----------------------|------------------------------|-------------------------------|
 * | `token/<hash>`        | Encrypted `WidgetTokenRecord` | Look up a token by its hash   |
 * | `user/<userId>`       | Encrypted `WidgetUserIndex`  | Look up a user's active token |
 *
 * All records are AES-256-GCM encrypted at rest via {@link encryptBlob} /
 * {@link decryptBlob}. Legacy plaintext records written before encryption was
 * introduced are migrated automatically on first read.
 *
 * ## Token lifecycle
 *
 * 1. `POST /api/widget-token` → {@link issueWidgetTokenForUser}
 *    - Generates a new opaque random token and stores its hash.
 *    - If the user already has an active token its old token record is deleted.
 * 2. `GET /api/widget-usage` → {@link resolveWidgetToken}
 *    - Hashes the bearer token from the request and looks up the record.
 *    - Returns `null` (401) if the token is missing or expired.
 * 3. `DELETE /api/widget-token` → {@link revokeWidgetTokenForUser}
 *    - Removes both the token record and the user index entry.
 */
import { getBlobStore } from './blob-store';
import { decryptBlob, encryptBlob, readBlobEncryptionKey } from './blob-crypto';
import type { SessionPayload } from './session';
import { generateOpaqueWidgetToken, hashWidgetToken, widgetTokenTtlSeconds } from './widget-token';

/** An encrypted blob record representing a single issued widget token. */
type WidgetTokenRecord = {
  /** HMAC-SHA256 hash of the raw bearer token (used as the blob key). */
  tokenHash: string;
  /** Numeric GitHub user ID of the token owner. */
  userId: number;
  /** GitHub login of the token owner. */
  login: string;
  /** The GitHub OAuth access token used to call the Copilot API on the widget's behalf. */
  githubAccessToken: string;
  /** ISO 8601 timestamp when this token was issued. */
  createdAt: string;
  /** ISO 8601 timestamp when this token expires. */
  expiresAt: string;
};

/** Per-user index blob that tracks the hash of the user's currently active widget token. */
type WidgetUserIndex = {
  /** Numeric GitHub user ID. */
  userId: number;
  /** GitHub login. */
  login: string;
  /** Hash of the currently active token; used to efficiently look up and delete old tokens. */
  activeTokenHash: string;
  /** ISO 8601 timestamp when this index was last written. */
  updatedAt: string;
  /** ISO 8601 timestamp when the current token expires. */
  expiresAt: string;
};

/** Return value of {@link issueWidgetTokenForUser}. */
type IssueResult = {
  /** The raw bearer token to hand to the user (shown once). */
  token: string;
  /** The persisted token record (without the raw token). */
  record: WidgetTokenRecord;
  /** `true` when a previous token was revoked as part of this issuance. */
  replacedExisting: boolean;
};

/** All recognized desired widget refresh cadence values, in minutes. */
export const VALID_REFRESH_CADENCES = [15, 30, 60, 120, 240] as const;

/** Desired widget refresh cadence in minutes, or `null` for manual (let iOS decide). */
export type WidgetRefreshCadence = typeof VALID_REFRESH_CADENCES[number] | null;

/** Per-user widget preferences stored in the widget-tokens blob store. */
export type WidgetUserSettings = {
  /** Desired refresh cadence in minutes, or null for manual. */
  desiredRefreshMinutes: WidgetRefreshCadence;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
};

const STORE_NAME = 'widget-tokens';
const STORE_UNAVAILABLE_ERROR = 'Widget token store unavailable';
const STORE_NOT_CONFIGURED_ERROR = 'Widget token store not configured';

function tokenKey(tokenHash: string): string {
  return `token/${tokenHash}`;
}

function userKey(userId: number): string {
  return `user/${userId}`;
}

function settingsKey(userId: number): string {
  return `settings/${userId}`;
}

function getWidgetStore() {
  try {
    return getBlobStore(STORE_NAME);
  } catch (error) {
    const wrappedError = new Error(STORE_UNAVAILABLE_ERROR);
    ;(wrappedError as Error & { cause?: unknown }).cause = error;
    throw wrappedError;
  }
}

/**
 * Returns `true` when the given error was thrown because Netlify Blobs is
 * unavailable in the current environment (e.g. missing site credentials).
 * Use this to return a `503` response rather than a generic `500`.
 */
export function isWidgetStoreUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_UNAVAILABLE_ERROR;
}

/**
 * Returns `true` when the given error was thrown because `BLOB_ENCRYPTION_KEY`
 * is not configured. Use this to return a `503 Service not configured` response.
 */
export function isWidgetStoreNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_NOT_CONFIGURED_ERROR;
}

function getBlobEncryptionKey() {
  try {
    return readBlobEncryptionKey();
  } catch (error) {
    const wrappedError = new Error(STORE_NOT_CONFIGURED_ERROR);
    ;(wrappedError as Error & { cause?: unknown }).cause = error;
    throw wrappedError;
  }
}

function looksEncryptedBlobRecord(raw: string): boolean {
  const parts = raw.split(':');
  if (parts.length !== 3) return false;
  const [ivHex, ciphertextHex, tagHex] = parts;
  return (
    Boolean(ivHex) &&
    Boolean(ciphertextHex) &&
    Boolean(tagHex) &&
    /^[0-9a-f]+$/.test(ivHex) &&
    /^[0-9a-f]+$/.test(ciphertextHex) &&
    /^[0-9a-f]+$/.test(tagHex)
  );
}

function keyKind(key: string): 'token' | 'user' | 'unknown' {
  if (key.startsWith('token/')) return 'token';
  if (key.startsWith('user/')) return 'user';
  return 'unknown';
}

async function readStoredRecord<T>(key: string): Promise<T | null> {
  const store = getWidgetStore();
  const encryptionKey = getBlobEncryptionKey();
  const raw = (await store.get(key, { type: 'text' })) as string | null;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const decrypted = decryptBlob(raw, encryptionKey);
  if (decrypted !== null) {
    try {
      return JSON.parse(decrypted) as T;
    } catch {
      console.warn('[widget-store] failed to parse decrypted blob record', { kind: keyKind(key) });
      return null;
    }
  }

  if (looksEncryptedBlobRecord(raw)) {
    console.warn('[widget-store] encrypted blob record failed integrity/decryption checks', { kind: keyKind(key) });
    return null;
  }

  try {
    const legacyRecord = JSON.parse(raw) as T;
    console.warn('[widget-store] migrated plaintext blob record to encrypted format');
    await store.set(key, encryptBlob(JSON.stringify(legacyRecord), encryptionKey));
    return legacyRecord;
  } catch {
    console.warn('[widget-store] failed to parse blob record as encrypted or legacy plaintext JSON');
    return null;
  }
}

async function writeStoredRecord<T>(key: string, record: T): Promise<void> {
  const store = getWidgetStore();
  const encryptionKey = getBlobEncryptionKey();
  await store.set(key, encryptBlob(JSON.stringify(record), encryptionKey));
}

async function getUserIndex(userId: number): Promise<WidgetUserIndex | null> {
  return readStoredRecord<WidgetUserIndex>(userKey(userId));
}

async function setUserIndex(index: WidgetUserIndex): Promise<void> {
  await writeStoredRecord(userKey(index.userId), index);
}

async function setTokenRecord(record: WidgetTokenRecord): Promise<void> {
  await writeStoredRecord(tokenKey(record.tokenHash), record);
}

async function deleteTokenRecord(tokenHash: string): Promise<void> {
  const store = getWidgetStore();
  await store.delete(tokenKey(tokenHash));
}

function isExpired(iso: string): boolean {
  return Date.now() >= new Date(iso).getTime();
}

/**
 * Returns the token status for a given user without exposing the raw token.
 *
 * If the stored token has expired it is revoked automatically and
 * `{ hasActiveToken: false }` is returned.
 *
 * @param userId - Numeric GitHub user ID.
 * @returns `{ hasActiveToken: true, expiresAt }` or `{ hasActiveToken: false }`.
 */
export async function getWidgetTokenStatusForUser(userId: number): Promise<{ hasActiveToken: boolean; expiresAt?: string }> {
  const index = await getUserIndex(userId);
  if (!index) return { hasActiveToken: false };

  if (isExpired(index.expiresAt)) {
    await revokeWidgetTokenForUser(userId);
    return { hasActiveToken: false };
  }

  return { hasActiveToken: true, expiresAt: index.expiresAt };
}

/**
 * Issues a new widget token for the authenticated user.
 *
 * Generates a new opaque random token, stores the hashed record in
 * `token/<hash>` and updates the user index at `user/<userId>`. If the user
 * already has an active token its old token record is deleted.
 *
 * The raw token is returned **exactly once** in the {@link IssueResult}; it
 * is not stored anywhere and cannot be recovered after this call returns.
 *
 * @param session - The verified session payload of the requesting user.
 * @returns The newly issued token, its persisted record, and whether an old
 *          token was revoked.
 */
export async function issueWidgetTokenForUser(session: SessionPayload): Promise<IssueResult> {
  const existing = await getUserIndex(session.id);

  const ttlSeconds = widgetTokenTtlSeconds();
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();

  const token = generateOpaqueWidgetToken();
  const tokenHash = hashWidgetToken(token);

  const record: WidgetTokenRecord = {
    tokenHash,
    userId: session.id,
    login: session.login,
    githubAccessToken: session.accessToken,
    createdAt: new Date(now).toISOString(),
    expiresAt
  };

  await setTokenRecord(record);
  await setUserIndex({
    userId: session.id,
    login: session.login,
    activeTokenHash: tokenHash,
    updatedAt: new Date(now).toISOString(),
    expiresAt
  });

  if (existing?.activeTokenHash) {
    await deleteTokenRecord(existing.activeTokenHash);
  }

  return {
    token,
    record,
    replacedExisting: Boolean(existing?.activeTokenHash)
  };
}

/**
 * Revokes the active widget token for a given user by deleting both the
 * token record and the user index entry.
 *
 * @param userId - Numeric GitHub user ID.
 * @returns `true` when a token was found and deleted; `false` when no active
 *          token existed.
 */
export async function revokeWidgetTokenForUser(userId: number): Promise<boolean> {
  const store = getWidgetStore();
  const existing = await getUserIndex(userId);

  if (!existing?.activeTokenHash) {
    await store.delete(userKey(userId));
    return false;
  }

  await deleteTokenRecord(existing.activeTokenHash);
  await store.delete(userKey(userId));
  return true;
}

/**
 * Resolves a raw widget bearer token to its stored record.
 *
 * The token is hashed before the lookup so the raw value is never compared
 * directly against stored data. Expired tokens are deleted automatically and
 * `null` is returned.
 *
 * @param token - The raw bearer token from the `Authorization` header.
 * @returns The valid, non-expired {@link WidgetTokenRecord}, or `null` when the
 *          token is unknown, expired, or the store is unavailable.
 */
export async function resolveWidgetToken(token: string): Promise<WidgetTokenRecord | null> {
  const store = getWidgetStore();
  const tokenHash = hashWidgetToken(token);
  const record = await readStoredRecord<WidgetTokenRecord>(tokenKey(tokenHash));

  if (!record) return null;

  if (isExpired(record.expiresAt)) {
    await deleteTokenRecord(record.tokenHash);
    const index = await getUserIndex(record.userId);
    if (index?.activeTokenHash === record.tokenHash) {
      await store.delete(userKey(record.userId));
    }
    return null;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Widget user settings
// ---------------------------------------------------------------------------

const VALID_CADENCES_SET: ReadonlySet<number> = new Set(VALID_REFRESH_CADENCES);

/**
 * Parses and validates a raw cadence value from an API request or stored
 * record. Returns a recognized cadence in minutes, or `null` (manual/default)
 * for absent, unknown, or out-of-range values.
 *
 * Only the values in {@link VALID_REFRESH_CADENCES} are accepted; all other
 * inputs are clamped to `null` rather than passed through.
 *
 * @param value - The raw cadence value from user input or a JSON payload.
 * @returns A valid cadence in minutes, or `null` for manual/default.
 */
export function parseWidgetRefreshCadence(value: unknown): WidgetRefreshCadence {
  // Explicit early returns for the most common "no preference" sentinels.
  // Note: '' would also be rejected further down (Number('') → 0, not a valid
  // cadence), but the early check makes the intent explicit.
  if (value === null || value === undefined || value === '' || value === 'manual') return null;
  // Reject non-primitive types (objects, arrays) — only strings and numbers are accepted.
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const asInt = Math.round(n);
  return VALID_CADENCES_SET.has(asInt) ? (asInt as WidgetRefreshCadence) : null;
}

/**
 * Returns the stored widget user settings for the given user, or `null` if
 * none have been saved yet.
 *
 * @param userId - Numeric GitHub user ID.
 */
export async function getWidgetUserSettings(userId: number): Promise<WidgetUserSettings | null> {
  return readStoredRecord<WidgetUserSettings>(settingsKey(userId));
}

/**
 * Persists widget user settings for the given user.
 *
 * @param userId - Numeric GitHub user ID.
 * @param settings - The settings to store.
 */
export async function setWidgetUserSettings(userId: number, settings: WidgetUserSettings): Promise<void> {
  await writeStoredRecord(settingsKey(userId), settings);
}
