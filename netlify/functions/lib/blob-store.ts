/**
 * @file Shared Netlify Blobs store access helper.
 *
 * ## Credential selection
 *
 * By default, every store is opened with ambient credentials:
 *   `getStore({ name })`
 *
 * Explicit credentials (`siteID` + `token`) are passed **only** when:
 * - `BLOBS_USE_EXPLICIT_CREDENTIALS=true`, **and**
 * - both `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN` are non-empty.
 *
 * `NETLIFY_AUTH_TOKEN` alone does **not** enable the explicit-credentials
 * path so that deployed Netlify Functions continue to use ambient
 * credentials automatically.
 */
import { getStore } from '@netlify/blobs'

/**
 * Returns a Netlify Blobs store for the given name using the project-wide
 * credential selection rule (see module-level JSDoc above).
 *
 * @param name - The Netlify Blobs store name.
 */
export function getBlobStore(name: string): ReturnType<typeof getStore> {
  if (
    process.env.BLOBS_USE_EXPLICIT_CREDENTIALS === 'true' &&
    process.env.NETLIFY_SITE_ID &&
    process.env.NETLIFY_AUTH_TOKEN
  ) {
    return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN })
  }
  return getStore({ name })
}
