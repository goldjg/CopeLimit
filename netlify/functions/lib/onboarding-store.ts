import { getStore } from '@netlify/blobs';
import type { SessionPayload } from './session';
import { decryptBlob, encryptBlob, readBlobEncryptionKey } from './blob-crypto';
import { generateOpaqueWidgetToken, hashWidgetToken } from './widget-token';

export type BootstrapTokenRecord = {
  tokenHash: string;
  userId: number;
  login: string;
  githubAccessToken: string;
  createdAt: string;
  expiresAt: string;
};

type BootstrapUserIndex = {
  userId: number;
  activeTokenHash: string;
  expiresAt: string;
  updatedAt: string;
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

function getOnboardingStore() {
  try {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN;

    if (siteID && token) {
      return getStore({ name: STORE_NAME, siteID, token });
    }

    return getStore({ name: STORE_NAME });
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

async function deleteBootstrapRecord(tokenHash: string): Promise<void> {
  const store = getOnboardingStore();
  await store.delete(bootstrapTokenKey(tokenHash));
}

export function onboardingBootstrapTtlSeconds(): number {
  return bootstrapTtlSeconds();
}

export function isOnboardingStoreUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_UNAVAILABLE_ERROR;
}

export function isOnboardingStoreNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_NOT_CONFIGURED_ERROR;
}

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

export async function issueBootstrapToken(session: SessionPayload): Promise<{ token: string; expiresAt: string }> {
  const existing = await getUserIndex(session.id);

  const token = generateOpaqueWidgetToken();
  const tokenHash = hashWidgetToken(token);
  const now = Date.now();
  const expiresAt = new Date(now + bootstrapTtlSeconds() * 1000).toISOString();

  const record: BootstrapTokenRecord = {
    tokenHash,
    userId: session.id,
    login: session.login,
    githubAccessToken: session.accessToken,
    createdAt: new Date(now).toISOString(),
    expiresAt
  };

  await setBootstrapRecord(record);
  await setUserIndex({
    userId: session.id,
    activeTokenHash: tokenHash,
    expiresAt,
    updatedAt: new Date(now).toISOString()
  });

  if (existing?.activeTokenHash) {
    await deleteBootstrapRecord(existing.activeTokenHash);
  }

  return { token, expiresAt };
}

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
