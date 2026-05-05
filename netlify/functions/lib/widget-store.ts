import { getStore } from '@netlify/blobs';
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

async function getUserIndex(userId: number): Promise<WidgetUserIndex | null> {
  const store = getWidgetStore();
  return (await store.get(userKey(userId), { type: 'json' })) as WidgetUserIndex | null;
}

async function setUserIndex(index: WidgetUserIndex): Promise<void> {
  const store = getWidgetStore();
  await store.setJSON(userKey(index.userId), index);
}

async function setTokenRecord(record: WidgetTokenRecord): Promise<void> {
  const store = getWidgetStore();
  await store.setJSON(tokenKey(record.tokenHash), record);
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
  const record = (await store.get(tokenKey(tokenHash), { type: 'json' })) as WidgetTokenRecord | null;

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
