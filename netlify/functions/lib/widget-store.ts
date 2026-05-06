import { getStore } from '@netlify/blobs';
import { decryptBlob, encryptBlob, readBlobEncryptionKey } from './blob-crypto';
import type { SessionPayload } from './session';
import { generateOpaqueWidgetToken, hashWidgetToken, widgetTokenTtlSeconds } from './widget-token';

type WidgetTokenRecord = {
  tokenHash: string;
  userId: number;
  login: string;
  githubAccessToken: string;
  createdAt: string;
  expiresAt: string;
};

type WidgetUserIndex = {
  userId: number;
  login: string;
  activeTokenHash: string;
  updatedAt: string;
  expiresAt: string;
};

type IssueResult = {
  token: string;
  record: WidgetTokenRecord;
  replacedExisting: boolean;
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

function getWidgetStore() {
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

export function isWidgetStoreUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_UNAVAILABLE_ERROR;
}

export function isWidgetStoreNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message === STORE_NOT_CONFIGURED_ERROR;
}

function getBlobEncryptionKey() {
  try {
    return readBlobEncryptionKey();
  } catch (error) {
    throw new Error(STORE_NOT_CONFIGURED_ERROR, { cause: error });
  }
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
      return null;
    }
  }

  try {
    const legacyRecord = JSON.parse(raw) as T;
    await store.set(key, encryptBlob(JSON.stringify(legacyRecord), encryptionKey));
    return legacyRecord;
  } catch {
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

export async function getWidgetTokenStatusForUser(userId: number): Promise<{ hasActiveToken: boolean; expiresAt?: string }> {
  const index = await getUserIndex(userId);
  if (!index) return { hasActiveToken: false };

  if (isExpired(index.expiresAt)) {
    await revokeWidgetTokenForUser(userId);
    return { hasActiveToken: false };
  }

  return { hasActiveToken: true, expiresAt: index.expiresAt };
}

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
