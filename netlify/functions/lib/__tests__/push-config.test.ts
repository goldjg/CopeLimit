/**
 * Contract tests for push-config.ts.
 *
 * Verified contracts:
 * 1. Returns `isConfigured: false` and all `null` values when env vars are absent.
 * 2. Returns `isConfigured: false` when only some env vars are set.
 * 3. Returns `isConfigured: true` with all keys when all env vars are set.
 * 4. Trims whitespace from configured values.
 * 5. The private key is accessible in the returned config (server-side only).
 * 6. Returns `isConfigured: false` when any value is an empty string after trimming.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPushConfig } from '../push-config'

const VAPID_PUBLIC = 'BPm8s4zGxABcDefGhIjKlMnOpQrStUvWxYz1234567890abcdefghij='
const VAPID_PRIVATE = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890aBcDeFgHiJk='
const VAPID_SUBJECT = 'mailto:admin@example.com'

// ---------------------------------------------------------------------------
// Helper to set env vars for a test and clean up afterward
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env['VAPID_PUBLIC_KEY']
  delete process.env['VAPID_PRIVATE_KEY']
  delete process.env['VAPID_SUBJECT']
})

afterEach(() => {
  process.env = savedEnv
})

// ---------------------------------------------------------------------------
// Contract 1: missing env vars
// ---------------------------------------------------------------------------

describe('readPushConfig — missing configuration', () => {
  it('returns isConfigured false when all env vars are absent', () => {
    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
    expect(config.vapidPublicKey).toBeNull()
    expect(config.vapidPrivateKey).toBeNull()
    expect(config.vapidSubject).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract 2: partial configuration
// ---------------------------------------------------------------------------

describe('readPushConfig — partial configuration', () => {
  it('returns isConfigured false when only VAPID_PUBLIC_KEY is set', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
    expect(config.vapidPublicKey).toBeNull()
  })

  it('returns isConfigured false when VAPID_PRIVATE_KEY is missing', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    process.env['VAPID_SUBJECT'] = VAPID_SUBJECT
    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
  })

  it('returns isConfigured false when VAPID_SUBJECT is missing', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    process.env['VAPID_PRIVATE_KEY'] = VAPID_PRIVATE
    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Contract 3: full configuration
// ---------------------------------------------------------------------------

describe('readPushConfig — full configuration', () => {
  it('returns isConfigured true when all env vars are set', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    process.env['VAPID_PRIVATE_KEY'] = VAPID_PRIVATE
    process.env['VAPID_SUBJECT'] = VAPID_SUBJECT

    const config = readPushConfig()
    expect(config.isConfigured).toBe(true)
    expect(config.vapidPublicKey).toBe(VAPID_PUBLIC)
    expect(config.vapidPrivateKey).toBe(VAPID_PRIVATE)
    expect(config.vapidSubject).toBe(VAPID_SUBJECT)
  })
})

// ---------------------------------------------------------------------------
// Contract 4: whitespace trimming
// ---------------------------------------------------------------------------

describe('readPushConfig — whitespace trimming', () => {
  it('trims surrounding whitespace from all values', () => {
    process.env['VAPID_PUBLIC_KEY'] = `  ${VAPID_PUBLIC}  `
    process.env['VAPID_PRIVATE_KEY'] = `\t${VAPID_PRIVATE}\n`
    process.env['VAPID_SUBJECT'] = ` ${VAPID_SUBJECT} `

    const config = readPushConfig()
    expect(config.isConfigured).toBe(true)
    expect(config.vapidPublicKey).toBe(VAPID_PUBLIC)
    expect(config.vapidPrivateKey).toBe(VAPID_PRIVATE)
    expect(config.vapidSubject).toBe(VAPID_SUBJECT)
  })
})

// ---------------------------------------------------------------------------
// Contract 5: private key is accessible server-side
// ---------------------------------------------------------------------------

describe('readPushConfig — private key accessibility', () => {
  it('exposes the private key in the config object (for server-side use)', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    process.env['VAPID_PRIVATE_KEY'] = VAPID_PRIVATE
    process.env['VAPID_SUBJECT'] = VAPID_SUBJECT

    const config = readPushConfig()
    // Private key must be available server-side for future push delivery
    expect(config.vapidPrivateKey).toBe(VAPID_PRIVATE)
    expect(config.vapidPrivateKey).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract 6: empty strings after trimming
// ---------------------------------------------------------------------------

describe('readPushConfig — empty strings after trimming', () => {
  it('returns isConfigured false when VAPID_PUBLIC_KEY is only whitespace', () => {
    process.env['VAPID_PUBLIC_KEY'] = '   '
    process.env['VAPID_PRIVATE_KEY'] = VAPID_PRIVATE
    process.env['VAPID_SUBJECT'] = VAPID_SUBJECT

    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
    expect(config.vapidPublicKey).toBeNull()
  })

  it('returns isConfigured false when any value is an empty string', () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC
    process.env['VAPID_PRIVATE_KEY'] = ''
    process.env['VAPID_SUBJECT'] = VAPID_SUBJECT

    const config = readPushConfig()
    expect(config.isConfigured).toBe(false)
  })
})
