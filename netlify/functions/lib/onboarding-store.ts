/**
 * @file Netlify Blobs storage layer for iOS onboarding bootstrap tokens.
 *
 * ## What is a bootstrap token?
 *
 * The iOS onboarding flow needs to hand a short-lived, single-use credential
 * to the `CopeLimitInstall.js` Scriptable script running on-device. The
 * Scriptable script cannot access the web session cookie, so instead the PWA:
 *
 * 1. Calls `POST /api/onboarding/session` to obtain a **bootstrap token** (15-minute TTL).
 * 2. Encodes the bootstrap token in the JSON payload it copies to the clipboard.
 * 3. Launches the Shortcuts app which in turn runs `CopeLimitInstall.js`.
 * 4. `CopeLimitInstall.js` calls `POST /api/onboarding/exchange` with the
 *    bootstrap token, which:
 *    a. Consumes (deletes) the bootstrap token so it cannot be reused.
 *    b. Issues a long-lived widget token on behalf of the user.
 *    c. Returns the widget token for Keychain storage.
 *
 * ## Blob store layout (`onboarding-sessions`)
 *
 * | Key                       | Value                          | Purpose                          |
 * |---------------------------|--------------------------------|----------------------------------|
 * | `bt/<hash>`               | Encrypted `BootstrapTokenRecord` | Look up a token for exchange   |
 * | `onboarding-user/<userId>`| Encrypted `BootstrapUserIndex` | Track the active token per user  |
 *
 * All records are AES-256-GCM encrypted at rest via {@link encryptBlob}.
 */
import { getBlobStore } from './blob-store';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SessionPayload } from './session';
import { decryptBlob, encryptBlob, readBlobEncryptionKey } from './blob-crypto';
import { generateOpaqueWidgetToken, hashWidgetToken } from './widget-token';

/** Persisted record for a single-use onboarding bootstrap token. */
export type BootstrapTokenRecord = {
  /** HMAC-SHA256 hash of the raw bootstrap token. */
  tokenHash: string;
  /** Numeric GitHub user ID of the requesting user. */
  userId: number;
  /** GitHub login of the requesting user. */
  login: string;
  /** The OAuth access token used to call the Copilot API once the token is exchanged. */
  githubAccessToken: string;
  /** Correlated onboarding session identifier for Fast Setup verification. */
  onboardingSessionId?: string;
  /** ISO 8601 timestamp when this bootstrap token was issued. */
  createdAt: string;
  /** ISO 8601 timestamp when this bootstrap token expires (default: 15 minutes). */
  expiresAt: string;
};

type BootstrapUserIndex = {
  userId: number;
  activeTokenHash: string;
  expiresAt: string;
  updatedAt: string;
};

export type OnboardingSessionRecord = {
  sessionId: string;
  userId: number;
  login: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  scriptableConfigured: boolean;
};

export type OnboardingSessionStatus = {
  sessionId: string;
  completed: boolean;
  completedAt: string | null;
  scriptableConfigured: boolean;
};

const STORE_NAME = 'onboarding-sessions';
const STORE_UNAVAILABLE_ERROR = 'Onboarding store unavailable';
const STORE_NOT_CONFIGURED_ERROR = 'Onboarding store not configured';
const DEFAULT_BOOTSTRAP_TTL_SECONDS = 900;

function bootstrapTokenKey(tokenHash: string): string {
  return `bt/${tokenHash}`;
}

function onboardingUserKey(userId: number): string {
  return `onboarding-user/${userId}`;
}

function onboardingSessionKey(sessionId: string): string {
  return `session/${sessionId}`;
}

function createOnboardingSessionId(): string {
  try {
    return randomUUID();
  } catch {
    return `onb_${randomBytes(16).toString('hex')}`;
  }
}

function getOnboardingStore() {
  try {
    return getBlobStore(STORE_NAME);
  } catch (error) {
    throw new Error(STORE_UNAVAILABLE_ERROR, { cause: error });
  }
}

function getBlobEncryptionKey() {
  try {
    return readBlobEncryptionKey();
  } catch (error) {
    throw new Error(STORE_NOT_CONFIGURED_ERROR, { cause: error });
  }
}

function bootstrapTtlSeconds(): number {
  const raw = parseInt(process.env.ONBOARDING_BOOTSTRAP_TTL_SECONDS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BOOTSTRAP_TTL_SECONDS;
}

function isExpired(iso: string): boolean {
  return Date.now() >= new Date(iso).getTime();
}

async function readEncryptedRecord<T>(key: string): Promise<T | null> {
  const store = getOnboardingStore();
  const encryptionKey = getBlobEncryptionKey();
  const raw = (await store.get(key, { type: 'text' })) as string | null;

  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const decrypted = decryptBlob(raw, encryptionKey);
  if (!decrypted) {
    return null;
  }

  try {
    return JSON.parse(decrypted) as T;
  } catch {
    return null;
  }
}

async function writeEncryptedRecord<T>(key: string, record: T): Promise<void> {
  const store = getOnboardingStore();
  const encryptionKey = getBlobEncryptionKey();
  await store.set(key, encryptBlob(JSON.stringify(record), encryptionKey));
}

async function getUserIndex(userId: number): Promise<BootstrapUserIndex | null> {
  return readEncryptedRecord<BootstrapUserIndex>(onboardingUserKey(userId));
}

async function setUserIndex(index: BootstrapUserIndex): Promise<void> {
  await writeEncryptedRecord(onboardingUserKey(index.userId), index);
}

async function setBootstrapRecord(record: BootstrapTokenRecord): Promise<void> {
  await writeEncryptedRecord(bootstrapTokenKey(record.tokenHash), record);
}

async function setOnboardingSessionRecord(record: OnboardingSessionRecord): Promise<void> {
  await writeEncryptedRecord(onboardingSessionKey(record.sessionId), record);
}

async function getOnboardingSessionRecord(sessionId: string): Promise<OnboardingSessionRecord | null> {
  return readEncryptedRecord<OnboardingSessionRecord>(onboardingSessionKey(sessionId));
}

async function deleteBootstrapRecord(tokenHash: string): Promise<void> {
  const store = getOnboardingStore();
  await store.delete(bootstrapTokenKey(tokenHash));
}

/**
 * Returns the bootstrap token TTL in seconds.
 * Reads `ONBOARDING_BOOTSTRAP_TTL_SECONDS`; defaults to 900 (15 minutes).
 */
export function onboardingBootstrapTtlSeconds(): number {
  return bootstrapTtlSeconds();
}

/**
 * Returns `true` when the error indicates the onboarding Blobs store is
 * unavailable in the current environment (e.g. missing Netlify credentials).
 */
export function isOnboardingStoreUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_UNAVAILABLE_ERROR;
}

/**
 * Returns `true` when the error indicates `BLOB_ENCRYPTION_KEY` is not
 * configured. Use this to return a `503 Service not configured` response.
 */
export function isOnboardingStoreNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_NOT_CONFIGURED_ERROR;
}

/**
 * Revokes the active bootstrap token for a user, deleting both the token
 * record and the user index entry. Safe to call when no token exists.
 *
 * @param userId - Numeric GitHub user ID.
 */
export async function revokeBootstrapTokenForUser(userId: number): Promise<void> {
  const store = getOnboardingStore();
  const index = await getUserIndex(userId);
  if (!index?.activeTokenHash) {
    await store.delete(onboardingUserKey(userId));
    return;
  }

  await deleteBootstrapRecord(index.activeTokenHash);
  await store.delete(onboardingUserKey(userId));
}

/**
 * Issues a short-lived, single-use bootstrap token for the given authenticated
 * session. Any previously active bootstrap token for the same user is revoked.
 *
 * The raw token is returned **exactly once**; only its hash is persisted.
 *
 * @param session - The verified session payload of the requesting user.
 * @returns The raw bootstrap token and its expiry timestamp.
 */
export async function issueBootstrapToken(session: SessionPayload): Promise<{ token: string; expiresAt: string; onboardingSessionId: string }> {
  const existing = await getUserIndex(session.id);

  const token = generateOpaqueWidgetToken();
  const tokenHash = hashWidgetToken(token);
  const onboardingSessionId = createOnboardingSessionId();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + bootstrapTtlSeconds() * 1000).toISOString();

  const record: BootstrapTokenRecord = {
    tokenHash,
    userId: session.id,
    login: session.login,
    githubAccessToken: session.accessToken,
    onboardingSessionId,
    createdAt,
    expiresAt
  };

  await setBootstrapRecord(record);
  await setOnboardingSessionRecord({
    sessionId: onboardingSessionId,
    userId: session.id,
    login: session.login,
    createdAt,
    expiresAt,
    completedAt: null,
    scriptableConfigured: false
  });
  await setUserIndex({
    userId: session.id,
    activeTokenHash: tokenHash,
    expiresAt,
    updatedAt: createdAt
  });

  if (existing?.activeTokenHash) {
    await deleteBootstrapRecord(existing.activeTokenHash);
  }

  return { token, expiresAt, onboardingSessionId };
}

/**
 * Resolves and consumes a bootstrap token in a single atomic operation.
 *
 * - Hashes the raw token for storage lookup.
 * - Returns `null` if the token is unknown or expired.
 * - **Deletes** the token record (and the user index entry if it matches) so
 *   the same token cannot be used more than once.
 *
 * @param rawToken - The raw bootstrap token received from the Scriptable script.
 * @returns The associated {@link BootstrapTokenRecord} if valid, or `null`.
 */
export async function resolveAndConsumeBootstrapToken(rawToken: string): Promise<BootstrapTokenRecord | null> {
  const store = getOnboardingStore();
  const tokenHash = hashWidgetToken(rawToken);
  const key = bootstrapTokenKey(tokenHash);
  const record = await readEncryptedRecord<BootstrapTokenRecord>(key);

  if (!record) {
    return null;
  }

  if (isExpired(record.expiresAt)) {
    await store.delete(key);
    const userIndex = await getUserIndex(record.userId);
    if (userIndex?.activeTokenHash === record.tokenHash) {
      await store.delete(onboardingUserKey(record.userId));
    }
    return null;
  }

  await store.delete(key);

  const userIndex = await getUserIndex(record.userId);
  if (userIndex?.activeTokenHash === record.tokenHash) {
    await store.delete(onboardingUserKey(record.userId));
  }

  return record;
}

/**
 * Marks an onboarding session as completed after successful bootstrap token exchange.
 */
export async function markOnboardingSessionCompleted(
  sessionId: string,
  options?: { scriptableConfigured?: boolean }
): Promise<boolean> {
  if (!sessionId) return false;
  const existing = await getOnboardingSessionRecord(sessionId);
  if (!existing) return false;

  const completedAt = existing.completedAt ?? new Date().toISOString();
  await setOnboardingSessionRecord({
    ...existing,
    completedAt,
    scriptableConfigured: options?.scriptableConfigured ?? existing.scriptableConfigured
  });
  return true;
}

/**
 * Returns status for an onboarding session owned by a specific user.
 */
export async function readOnboardingSessionStatus(
  sessionId: string,
  userId: number
): Promise<OnboardingSessionStatus | null> {
  if (!sessionId) return null;
  const record = await getOnboardingSessionRecord(sessionId);
  if (!record || record.userId !== userId) return null;

  return {
    sessionId: record.sessionId,
    completed: record.completedAt !== null,
    completedAt: record.completedAt,
    scriptableConfigured: Boolean(record.scriptableConfigured)
  };
}
