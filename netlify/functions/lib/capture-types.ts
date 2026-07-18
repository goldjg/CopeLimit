/**
 * @file Shared types for the provider response capture subsystem.
 *
 * The capture subsystem is an optional telemetry feature that records
 * sanitised raw provider responses to Netlify Blobs. It is disabled by
 * default and must be enabled explicitly via the `CAPTURE_PROVIDER_RESPONSES`
 * environment variable.
 *
 * All sensitive fields are stripped by {@link sanitizeProviderPayload} before
 * any data is persisted. The `billingEntity` field is also excluded from
 * {@link CapturedNormalizedUsage} to avoid storing GitHub logins alongside
 * raw provider data.
 *
 * @see {@link readCaptureConfig} for environment variable configuration
 * @see {@link maybeCapture} for the capture entry point
 */
import type { JsonObject, Usage } from './copilot'

/** Runtime configuration for the provider capture subsystem. */
export type CaptureConfig = {
  /** Whether provider response capture is enabled (default: `false`). */
  enabled: boolean;
  /**
   * Number of calendar days to retain captured records.
   * Records older than this are deleted lazily on the next capture for the
   * same provider/user (default: 30).
   */
  retentionDays: number;
  /**
   * Maximum number of captures stored per provider, per user, per UTC day.
   * Further captures on the same day are silently dropped (default: 10).
   */
  maxPerDay: number;
  /**
   * Whether to include the normalised {@link Usage} record (minus
   * `billingEntity`) alongside the sanitised raw payload (default: `true`).
   */
  includeNormalized: boolean;
}

/** Provider-sanitised payload with metadata about which fields were seen. */
export type SanitizedPayload = JsonObject & {
  /** All top-level field names present in the raw provider response. */
  _rawFieldNames: string[];
  /** Paths of fields that were stripped (sensitive or unknown). */
  _unknown_fields: string[];
}

/** {@link Usage} with `billingEntity` omitted to avoid storing GitHub logins. */
export type CapturedNormalizedUsage = Omit<Usage, 'billingEntity'>

/** A single persisted provider capture record. */
export type ProviderCapture = {
  /** Schema version for future migration support. Always `"1"`. */
  captureVersion: '1';
  /** ISO 8601 timestamp when this capture was taken. */
  capturedAt: string;
  /** Provider identifier (e.g. `github-copilot-internal`). */
  provider: string;
  /** Numeric GitHub user ID of the requesting user. */
  userId: number;
  /**
   * Normalised usage snapshot at the time of capture (omits `billingEntity`).
   * Only present when `includeNormalized` is `true` in the capture config.
   */
  normalized?: CapturedNormalizedUsage;
  /** Sanitised raw provider response (sensitive fields stripped). */
  sanitizedRaw: SanitizedPayload;
  /** Metadata about how this capture was produced. */
  meta: {
    /** HTTP status code of the upstream provider response, when available. */
    responseHttpStatus?: number;
    /** Schema version for the capture record. Always `"1"`. */
    captureSchemaVersion: '1';
    /** Whether a normalised usage snapshot is included. */
    includesNormalized: boolean;
    /** Version of the sanitiser that processed the raw payload. Always `"1"`. */
    sanitizerVersion: '1';
  };
}

/** Daily capture counter stored alongside the capture records. */
export type CaptureIndex = {
  /** Number of captures recorded on `date`. */
  count: number;
  /** UTC date string (`YYYY-MM-DD`) this index covers. */
  date: string;
}
