/**
 * @file TypeScript types for the WebPush subscription subsystem.
 *
 * Subscriptions are stored in the `push-subscriptions` Netlify Blobs store
 * so that future alert delivery code can retrieve registered endpoints and
 * send push messages.
 *
 * ## Blob store layout (`push-subscriptions`)
 *
 * ```
 * <userId>/<endpointHash>.json   — individual subscription record
 * ```
 *
 * The endpoint hash is the first 32 hex characters of a SHA-256 digest of the
 * subscription endpoint URL, providing a deterministic, URL-safe, fixed-length
 * key that maps one-to-one with a browser push subscription.
 *
 * ## Tier classification
 *
 * Records in `push-subscriptions` are **Tier 2** (user-controlled device
 * registration metadata). Records contain only the push endpoint URL, VAPID
 * keys, timestamps, and an optional user-agent label. They contain no access
 * tokens, no raw provider payloads, and no credential data.
 *
 * This module contains TypeScript type definitions only. It has no runtime
 * behaviour, no I/O, and no validation logic.
 */

/** Schema version for push subscription records in this release. */
export type PushSubscriptionSchemaVersion = '1'

/**
 * The cryptographic keys associated with a browser push subscription.
 *
 * These are the values produced by the browser's `PushSubscription.toJSON()`
 * method and are required by the push service to encrypt the message payload.
 */
export type PushSubscriptionKeys = {
  /** P-256 Diffie–Hellman public key, base64url-encoded. */
  p256dh: string;
  /** Authentication secret, base64url-encoded. */
  auth: string;
}

/**
 * A validated WebPush subscription payload as submitted by the browser.
 *
 * Corresponds to the JSON form of the browser's `PushSubscription` object.
 */
export type PushSubscriptionPayload = {
  /** The push service endpoint URL for this subscription. */
  endpoint: string;
  /** Encryption keys for the subscription. */
  keys: PushSubscriptionKeys;
  /**
   * Optional user-agent string sent by the browser.
   * Used only for debugging/labelling; never required for delivery.
   */
  userAgent?: string;
  /**
   * Optional source label (e.g. `"copelimit-pwa"`) for identifying
   * which client registered the subscription.
   */
  source?: string;
}

/**
 * A push subscription record stored in Netlify Blobs.
 *
 * Wraps a {@link PushSubscriptionPayload} with schema version metadata,
 * the numeric GitHub user ID that owns the record, and lifecycle timestamps.
 */
export type PushSubscriptionRecord = {
  /** Schema version for migration support. Always `"1"`. */
  subscriptionVersion: PushSubscriptionSchemaVersion;
  /** Numeric GitHub user ID of the user who owns this subscription. */
  userId: number;
  /** The push service endpoint URL. */
  endpoint: string;
  /** Encryption keys for the subscription. */
  keys: PushSubscriptionKeys;
  /** ISO 8601 timestamp when this subscription was first registered. */
  createdAt: string;
  /**
   * ISO 8601 timestamp when this subscription was last updated
   * (e.g. re-registered by the same browser).
   */
  updatedAt: string;
  /**
   * Optional user-agent string of the browser that registered this
   * subscription. Stored for debugging purposes only.
   */
  userAgent?: string;
  /**
   * Optional source label identifying the registering client.
   */
  source?: string;
}

/**
 * A lightweight summary of a user's push subscription status.
 *
 * Returned by the status API endpoint so the client can determine whether
 * the VAPID public key is configured and how many subscriptions exist for
 * the authenticated user.
 */
export type PushSubscriptionStatus = {
  /** Total number of active subscriptions for this user. */
  subscriptionCount: number;
  /** Whether the user has at least one active subscription. */
  hasSubscriptions: boolean;
}
