# CopeLimit

Copilot quota dashboard and widget with Netlify Functions backend.

## Hosted Copilot provider

Use `github-copilot-internal` to fetch usage server-side from:

- `https://api.github.com/copilot_internal/user`

Set these environment variables in Netlify:

| Variable | Required | Value |
|---|---|---|
| `COPELIMIT_PROVIDER` | Yes | `github-copilot-internal` |
| `SESSION_SECRET` | Yes | Strong random string |
| `SESSION_ENCRYPTION_KEY` | Yes (production) | 64-char lowercase hex (32 bytes), e.g. `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |

Notes:
- OAuth scope now requests `read:user copilot`.
- Existing users should sign out and sign back in to refresh granted scopes.
- Copilot API calls are server-side only; tokens are never exposed to the browser.
- `SESSION_ENCRYPTION_KEY` is required in production so session cookies do not contain plaintext-decoded OAuth tokens.
