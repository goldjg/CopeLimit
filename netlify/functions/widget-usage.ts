/**
 * @file Netlify Function: `widget-usage`
 *
 * Unauthenticated (token-authenticated) Copilot usage endpoint for the
 * Scriptable iOS widget. This endpoint is called directly by
 * `CopeLimitWidget.js` on the device, which presents the widget bearer token
 * instead of a session cookie.
 *
 * ## Endpoint
 * `GET /api/widget-usage`
 *
 * ## Authentication
 * The widget token must be supplied in **one** of:
 * - `Authorization: Bearer <token>` header
 * - `X-Widget-Token: <token>` header
 *
 * ## Behaviour
 * 1. Extracts the raw bearer token from the request.
 * 2. Looks up the token hash in Netlify Blobs via {@link resolveWidgetToken}.
 * 3. Calls `api.github.com/copilot_internal/user` using the stored GitHub
 *    access token associated with the widget token record.
 * 4. Returns a normalised {@link Usage} JSON response.
 *
 * ## Response shape
 * Same as `/api/usage` — a {@link Usage} JSON object — with an optional
 * `widgetExtras` field when `?extras=1` is passed and history data exists:
 *
 * ```json
 * {
 *   "used": 5550,
 *   "quota": 7000,
 *   ...
 *   "widgetExtras": {
 *     "burnRate": 45.2,
 *     "burnRateCostPerHourUsd": 0.45,
 *     "sparkline": [1000, 2500, 3200, 5550],
 *     "quotaCeiling": 7000
 *   }
 * }
 * ```
 *
 * The large Scriptable widget passes `?extras=1` to receive `widgetExtras`.
 * Small and medium widgets omit the parameter to keep the response lean.
 *
 * ## Required environment variables
 * - `SESSION_SECRET` or `WIDGET_TOKEN_HASH_SECRET` – For HMAC token hashing
 * - `BLOB_ENCRYPTION_KEY` – For decrypting token records
 */
import type { Handler, HandlerEvent } from '@netlify/functions';
import {
  type Usage,
  isObject,
  getUnsupportedUsage,
  normalizeCopilotInternalPayload
} from './lib/copilot';
import { isWidgetStoreNotConfiguredError, isWidgetStoreUnavailableError, resolveWidgetToken, getWidgetUserSettings } from './lib/widget-store';
import type { WidgetRefreshCadence } from './lib/widget-store';
import { getHistory } from './lib/usage-history-store';
import { computeHistorySummary } from './lib/history-metrics';
import type { UsageHistorySnapshot } from './lib/usage-history-types';
import { creditsToUsd } from './lib/cost-metrics';
import { computeComfortStatus } from './lib/comfort-status';
import type { ComfortStatus } from './lib/comfort-status';
import { evaluateAlertDecision } from './lib/alert-decision';
import type { AlertDecision } from './lib/alert-decision';
import { projectBurnRate } from './lib/burn-rate-projection';
import type { BurnRateProjection } from './lib/burn-rate-projection';

/**
 * Extra telemetry derived from usage history, included in the widget-usage
 * response only when the `?extras=1` query parameter is present and history
 * data is available. Consumed by the large Scriptable widget layout.
 */
export type WidgetExtras = {
  /** Overall burn rate in credits per hour. `null` when fewer than 2 snapshots exist. */
  burnRate: number | null;
  /** Overall burn rate in estimated USD per hour. `null` when fewer than 2 snapshots exist. */
  burnRateCostPerHourUsd: number | null;
  /**
   * Ordered array of `used` values for sparkline rendering, oldest-first.
   * Contains at most 14 data points (the most recent snapshots, reversed).
   */
  sparkline: number[];
  /**
   * Representative quota ceiling (the largest quota across the sparkline
   * window). Lets the widget draw a fuel-gauge ceiling reference line so the
   * burn trail reads against the size of the tank. `0` when unknown.
   */
  quotaCeiling: number;
};

/**
 * Computes {@link WidgetExtras} from a list of usage history snapshots.
 *
 * Pure function — no I/O. Returns `undefined` when fewer than 2 snapshots
 * are present (burn rate requires at least one interval).
 *
 * @param snapshots - Array of snapshots in **newest-first** order (as returned
 *   by {@link getHistory}).
 * @returns Populated {@link WidgetExtras}, or `undefined` when insufficient data.
 */
export function computeWidgetExtras(
  snapshots: UsageHistorySnapshot[]
): WidgetExtras | undefined {
  if (snapshots.length < 2) return undefined;
  const summary = computeHistorySummary(snapshots);
  // Sparkline: take up to 14 newest snapshots, then reverse to oldest-first
  // so the chart reads left-to-right chronologically.
  const sparklineSnapshots = snapshots.slice(0, 14).reverse();
  const sparkline = sparklineSnapshots.map(s => s.used);
  // Quota ceiling: the largest quota seen across the sparkline window, so the
  // widget can render the tank size as a reference line. Defensive against
  // missing/non-finite quotas.
  const quotaCeiling = sparklineSnapshots.reduce((max, s) => {
    const q = typeof s.quota === 'number' && Number.isFinite(s.quota) && s.quota > 0 ? s.quota : 0;
    return q > max ? q : max;
  }, 0);
  const burnRateCostPerHourUsd =
    summary.creditsPerHour === null ? null : creditsToUsd(summary.creditsPerHour);
  return {
    burnRate: summary.creditsPerHour,
    burnRateCostPerHourUsd,
    sparkline,
    quotaCeiling
  };
}

function extractToken(event: HandlerEvent): string | undefined {
  const auth = event.headers['authorization'];
  return event.headers['x-widget-token'] ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
}

async function getWidgetCopilotInternalUsage(githubToken: string, login: string): Promise<Usage> {
  const response = await fetch('https://api.github.com/copilot_internal/user', {
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/json',
      'x-github-api-version': '2022-11-28',
      'editor-version': 'vscode/1.95.0',
      'copilot-integration-id': 'vscode-chat',
      'user-agent': 'CopeLimit/1.0'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      return getUnsupportedUsage(login, [
        'Stored GitHub token has expired or been revoked. Re-generate your widget token in CopeLimit.'
      ]);
    }
    if (response.status === 403) {
      return getUnsupportedUsage(login, [
        'Stored GitHub token does not have access to Copilot internal APIs. A Copilot subscription and the copilot OAuth scope are required.'
      ]);
    }
    if (response.status === 404) {
      return getUnsupportedUsage(login, ['No Copilot subscription found for this account.']);
    }
    throw new Error(`Copilot internal API returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) {
    return getUnsupportedUsage(login, [
      'Copilot API responded but did not include quota data. The response shape may have changed.'
    ]);
  }

  const { usage: normalizedUsage } = normalizeCopilotInternalPayload(
    body,
    login,
    'github-copilot-internal',
    ['Live data via GitHub Copilot internal API (widget token).']
  );

  if (normalizedUsage === null) {
    console.warn('[widget-usage] copilot_internal user payload missing quota fields');
    return getUnsupportedUsage(login, [
      'Copilot API responded but did not include quota data. The response shape may have changed.'
    ]);
  }

  return normalizedUsage;
}

export const handler: Handler = async (event) => {
  if (!process.env.WIDGET_TOKEN_HASH_SECRET && !process.env.SESSION_SECRET) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Service not configured' })
    };
  }

  const raw = extractToken(event);
  if (!raw) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const record = await resolveWidgetToken(raw);
    if (!record) {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    const usage = await getWidgetCopilotInternalUsage(record.githubAccessToken, record.login);

    // When the caller requests extras (e.g. the large widget), attempt to
    // enrich the response with burn-rate and sparkline data from history.
    // History failures are non-fatal: the widget falls back gracefully.
    const includeExtras =
      event.queryStringParameters?.['extras'] === '1' ||
      event.queryStringParameters?.['extras'] === 'true';

    let snapshots: UsageHistorySnapshot[] = [];
    if (includeExtras) {
      try {
        // Fetch slightly more than the 14-point sparkline cap to give
        // computeWidgetExtras headroom for burn-rate calculation intervals.
        const HISTORY_FETCH_LIMIT = 20;
        snapshots = await getHistory(record.userId, { limit: HISTORY_FETCH_LIMIT });
      } catch {
        // Non-fatal: extras are omitted when history is unavailable.
      }
    }

    // Burn-rate projection: computed from history when extras were requested
    // and sufficient snapshot data is available (≥2 snapshots). This mirrors
    // the logic in usage.ts so the widget endpoint produces the same canonical
    // comfort status as the PWA — preventing a colour/status mismatch.
    let burnRateProjection: BurnRateProjection | undefined;
    if (snapshots.length >= 2) {
      try {
        burnRateProjection = projectBurnRate(usage, snapshots);
      } catch (err) {
        // Non-fatal: projection failures must not affect the widget response.
        const errType = err instanceof Error ? err.name : typeof err;
        console.warn('[widget-usage] burn-rate projection failed', errType);
      }
    }

    // Comfort status: always included. Derived from the current usage AND the
    // burn-rate projection when available. Using the projection prevents the
    // widget from showing green/safe when credits are on track to exhaust
    // before the billing reset (the core status/colour mismatch bug).
    const comfortStatus: ComfortStatus = computeComfortStatus(usage, burnRateProjection);

    // Alert decision: additive, optional field. Evaluates whether the user
    // should be alerted based on the comfort status. Passes the projection
    // through for threshold checks (e.g. "within 24 h"). Never throws.
    let alertDecision: AlertDecision | undefined;
    try {
      alertDecision = evaluateAlertDecision({ usage, projection: burnRateProjection, comfortStatus });
    } catch {
      // Non-blocking: alert-decision failures must not affect the widget response.
    }

    let widgetExtras: WidgetExtras | undefined;
    if (snapshots.length >= 2) {
      widgetExtras = computeWidgetExtras(snapshots);
    }

    // User's desired widget refresh cadence from saved settings.
    // Non-fatal: falls back to null (manual / let iOS decide) on any error.
    let desiredRefreshMinutes: WidgetRefreshCadence = null;
    try {
      const settings = await getWidgetUserSettings(record.userId);
      desiredRefreshMinutes = settings?.desiredRefreshMinutes ?? null;
    } catch {
      // Non-fatal: widget falls back to manual refresh if settings are unavailable.
    }

    const responseBody = {
      ...usage,
      comfortStatus,
      ...(alertDecision !== undefined ? { alertDecision } : {}),
      ...(burnRateProjection !== undefined ? { burnRateProjection } : {}),
      ...(widgetExtras !== undefined ? { widgetExtras } : {}),
      desiredRefreshMinutes,
    };

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60'
      },
      body: JSON.stringify(responseBody)
    };
  } catch (error) {
    if (isWidgetStoreNotConfiguredError(error)) {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Service not configured' })
      };
    }
    if (isWidgetStoreUnavailableError(error)) {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Widget token storage is unavailable' })
      };
    }
    const errorType = error instanceof Error ? error.name : typeof error;
    console.error('[widget-usage] unexpected error while resolving widget usage', errorType);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
