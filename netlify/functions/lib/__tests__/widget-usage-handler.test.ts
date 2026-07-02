/**
 * Contract tests for the GET /api/widget-usage handler — status parity.
 *
 * These tests verify:
 * 1. Small/medium widgets (no `?extras=1`) receive `comfortStatus.level` of
 *    `'warm'` or `'hot'` when the burn-rate projection indicates
 *    `'exhaustion_before_reset'` — they must NOT show green/safe.
 * 2. Large widgets (`?extras=1`) receive the same canonical `comfortStatus`
 *    level as small/medium for the same underlying account state.
 * 3. `widgetExtras` is absent from no-extras responses and present in
 *    extras responses.
 * 4. When projection indicates `'reset_before_exhaustion'`, the level is
 *    `'safe'` or `'watch'` for all widget sizes.
 * 5. Regression: `credits_available` + `exhaustion_before_reset` produces
 *    `'warm'`/`'hot'` regardless of the `extras` query parameter.
 *
 * ## Fixture design
 *
 * Exhaustion scenario:
 *   - quota = 7000, rawRemaining = 1450 → used = 5550, billingPhase = credits_available
 *   - history: two snapshots, 24 h apart, +2000 credits → 83.3 credits/h
 *   - hoursUntilExhaustion = 1450 / 83.3 ≈ 17.4 h  (< 24 h → level = 'hot')
 *   - resetAt = 30 days = 720 h  >> 17.4 h → projectionStatus = 'exhaustion_before_reset'
 *
 * Safe scenario:
 *   - quota = 7000, rawRemaining = 6500 → used = 500, billingPhase = credits_available
 *   - history: two snapshots, 23 h apart, +100 credits → 4.35 credits/h
 *   - hoursUntilExhaustion = 6500 / 4.35 ≈ 1494 h  >> 720 h reset → 'reset_before_exhaustion'
 *   - percentUsed = 7 % < 75 % → level = 'safe'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';
import type { UsageHistorySnapshot } from '../usage-history-types';

// ---------------------------------------------------------------------------
// Module mocks (hoisted before all imports)
// ---------------------------------------------------------------------------

vi.mock('../widget-store', () => ({
  resolveWidgetToken: vi.fn(),
  getWidgetUserSettings: vi.fn(),
  isWidgetStoreNotConfiguredError: vi.fn().mockReturnValue(false),
  isWidgetStoreUnavailableError: vi.fn().mockReturnValue(false),
}));

vi.mock('../usage-history-store', () => ({
  getHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked functions after vi.mock declarations
// ---------------------------------------------------------------------------

import { resolveWidgetToken, getWidgetUserSettings } from '../widget-store';
import { getHistory } from '../usage-history-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_TOKEN = 'test-bearer-token-abc123';
const MOCK_RECORD = {
  userId: 99001,
  login: 'testwidgetuser',
  githubAccessToken: 'fake-gh-access-token',
  tokenHash: 'fake-token-hash',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function makeEvent(overrides: Partial<HandlerEvent> = {}): HandlerEvent {
  return {
    httpMethod: 'GET',
    path: '/api/widget-usage',
    headers: { 'x-widget-token': MOCK_TOKEN },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    rawUrl: 'http://localhost/api/widget-usage',
    rawQuery: '',
    ...overrides,
  };
}

/**
 * Builds a minimal GitHub copilot_internal/user API JSON payload that
 * normalises to the given quota values with billingPhase = credits_available.
 * `rawRemaining` is the pre-clamp remaining value; `used` = quota - rawRemaining.
 */
function makeGitHubApiBody(
  quota: number,
  rawRemaining: number,
  resetAtIso: string,
): object {
  return {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: quota,
        remaining: rawRemaining,
        overage_permitted: false,
        overage_count: 0,
        unlimited: false,
        has_quota: true,
      },
    },
    quota_reset_at: resetAtIso,
  };
}

/**
 * Creates a mock `Response` for the GitHub API that returns the given body.
 */
function makeGitHubFetchResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Builds a UsageHistorySnapshot (newest-first order, as returned by getHistory).
 */
function makeSnapshot(capturedAt: string, used: number, quota = 7000): UsageHistorySnapshot {
  return {
    capturedAt,
    used,
    quota,
    remaining: Math.max(0, quota - used),
    billingPhase: 'credits_available',
  };
}

/** Returns an ISO timestamp for `offsetMs` milliseconds from now. */
function nowPlus(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const H = 3_600_000; // one hour in ms
const D = 24 * H;   // one day in ms

// ---------------------------------------------------------------------------
// Fixture datasets
// ---------------------------------------------------------------------------

/**
 * Exhaustion scenario: burn rate ≈ 83.3 credits/h, exhaustion in ≈ 17.4 h.
 * Expected projectionStatus: 'exhaustion_before_reset'
 * Expected comfortStatus.level: 'hot' (< 24 h until exhaustion)
 */
const EXHAUSTION_RESET_AT = nowPlus(30 * D);  // 30 days from now
const EXHAUSTION_API_BODY = makeGitHubApiBody(7000, 1450, EXHAUSTION_RESET_AT);
// Two snapshots: 26 h ago → 2 h ago, +2000 credits in 24 h = 83.3/h
const EXHAUSTION_SNAPSHOTS: UsageHistorySnapshot[] = [
  makeSnapshot(nowPlus(-2 * H),  5550),   // newest
  makeSnapshot(nowPlus(-26 * H), 3550),   // oldest
];

/**
 * Safe scenario: burn rate ≈ 4.35 credits/h, exhaustion in ≈ 1494 h.
 * Expected projectionStatus: 'reset_before_exhaustion'
 * Expected comfortStatus.level: 'safe' (percentUsed < 75%)
 */
const SAFE_RESET_AT = nowPlus(30 * D);
const SAFE_API_BODY = makeGitHubApiBody(7000, 6500, SAFE_RESET_AT);
// Two snapshots: 24 h ago → 1 h ago, +100 credits in 23 h ≈ 4.35/h
const SAFE_SNAPSHOTS: UsageHistorySnapshot[] = [
  makeSnapshot(nowPlus(-1 * H),  500),   // newest
  makeSnapshot(nowPlus(-24 * H), 400),   // oldest
];

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

async function loadHandler() {
  const mod = await import('../../widget-usage');
  return mod.handler;
}

beforeEach(() => {
  process.env.WIDGET_TOKEN_HASH_SECRET = 'test-secret-for-widget-handler-tests';
  vi.mocked(resolveWidgetToken).mockResolvedValue(MOCK_RECORD as never);
  vi.mocked(getWidgetUserSettings).mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.WIDGET_TOKEN_HASH_SECRET;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Contract assertion 1: small/medium (no extras) gets warm/hot on exhaustion risk
// ---------------------------------------------------------------------------

describe('widget-usage — no-extras request (small/medium widget)', () => {
  it('returns hot comfortStatus when projection indicates exhaustion_before_reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    // No ?extras=1 — simulates small/medium widget
    const response = await handler(makeEvent(), {} as never);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);

    // comfortStatus must be warm or hot (projection-driven) — NOT safe/watch
    expect(['warm', 'hot']).toContain(body.comfortStatus.level);
    expect(body.comfortStatus.primarySignal).toBe('burn_rate');
  });

  it('does not include widgetExtras in the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(makeEvent(), {} as never);

    const body = JSON.parse(response.body!);
    expect(body.widgetExtras).toBeUndefined();
  });

  it('returns safe/watch comfortStatus when projection indicates reset_before_exhaustion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(SAFE_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(SAFE_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(makeEvent(), {} as never);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);

    expect(['safe', 'watch']).toContain(body.comfortStatus.level);
    expect(body.comfortStatus.primarySignal).toBe('burn_rate');
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 2: large widget (extras=1) gets the same canonical level
// ---------------------------------------------------------------------------

describe('widget-usage — extras request (large widget)', () => {
  it('returns hot comfortStatus (same as no-extras) when projection indicates exhaustion_before_reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(
      makeEvent({ queryStringParameters: { extras: '1' } }),
      {} as never,
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);

    expect(['warm', 'hot']).toContain(body.comfortStatus.level);
    expect(body.comfortStatus.primarySignal).toBe('burn_rate');
  });

  it('includes widgetExtras in the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(
      makeEvent({ queryStringParameters: { extras: '1' } }),
      {} as never,
    );

    const body = JSON.parse(response.body!);
    expect(body.widgetExtras).toBeDefined();
    expect(Array.isArray(body.widgetExtras.sparkline)).toBe(true);
    expect(body.widgetExtras.sparkline.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 3: comfortStatus.level is identical for all widget sizes
// ---------------------------------------------------------------------------

describe('widget-usage — status parity across widget sizes', () => {
  it('no-extras and extras produce the same comfortStatus.level for exhaustion scenario', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();

    const [smallResponse, largeResponse] = await Promise.all([
      handler(makeEvent(), {} as never),
      handler(makeEvent({ queryStringParameters: { extras: '1' } }), {} as never),
    ]);

    const smallBody = JSON.parse(smallResponse.body!);
    const largeBody = JSON.parse(largeResponse.body!);

    expect(smallBody.comfortStatus.level).toBe(largeBody.comfortStatus.level);
    expect(smallBody.comfortStatus.primarySignal).toBe(largeBody.comfortStatus.primarySignal);
  });

  it('no-extras and extras produce the same comfortStatus.level for safe scenario', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(SAFE_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(SAFE_SNAPSHOTS);

    const handler = await loadHandler();

    const [smallResponse, largeResponse] = await Promise.all([
      handler(makeEvent(), {} as never),
      handler(makeEvent({ queryStringParameters: { extras: '1' } }), {} as never),
    ]);

    const smallBody = JSON.parse(smallResponse.body!);
    const largeBody = JSON.parse(largeResponse.body!);

    expect(smallBody.comfortStatus.level).toBe(largeBody.comfortStatus.level);
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 4 (regression): credits_available + exhaustion_before_reset
// must never render green/safe regardless of extras parameter
// ---------------------------------------------------------------------------

describe('widget-usage — regression: credits_available + exhaustion_before_reset', () => {
  it('no-extras response is NOT safe when billingPhase=credits_available and projection=exhaustion_before_reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(makeEvent(), {} as never);

    const body = JSON.parse(response.body!);
    // billingPhase must be credits_available (the scenario's precondition)
    expect(body.billingPhase).toBe('credits_available');
    // Must NOT be safe or watch — projection risk must surface
    expect(['safe', 'watch', 'unknown']).not.toContain(body.comfortStatus.level);
  });

  it('extras response is NOT safe when billingPhase=credits_available and projection=exhaustion_before_reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockResolvedValue(EXHAUSTION_SNAPSHOTS);

    const handler = await loadHandler();
    const response = await handler(
      makeEvent({ queryStringParameters: { extras: '1' } }),
      {} as never,
    );

    const body = JSON.parse(response.body!);
    expect(body.billingPhase).toBe('credits_available');
    expect(['safe', 'watch', 'unknown']).not.toContain(body.comfortStatus.level);
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 5: history unavailability degrades gracefully for all sizes
// ---------------------------------------------------------------------------

describe('widget-usage — history unavailable degrades gracefully', () => {
  it('no-extras request returns 200 with comfortStatus when getHistory throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockRejectedValue(new Error('blob store unavailable'));

    const handler = await loadHandler();
    const response = await handler(makeEvent(), {} as never);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);
    expect(body.comfortStatus).toBeDefined();
    expect(body.comfortStatus.level).toBeDefined();
    // Without history, projection is unavailable; falls back to warningLevel
    expect(body.burnRateProjection).toBeUndefined();
  });

  it('extras request returns 200 without widgetExtras when getHistory throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGitHubFetchResponse(EXHAUSTION_API_BODY)));
    vi.mocked(getHistory).mockRejectedValue(new Error('blob store unavailable'));

    const handler = await loadHandler();
    const response = await handler(
      makeEvent({ queryStringParameters: { extras: '1' } }),
      {} as never,
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);
    expect(body.widgetExtras).toBeUndefined();
  });
});
