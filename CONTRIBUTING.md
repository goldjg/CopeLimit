# Contributing to CopeLimit

Thank you for your interest in contributing! This document covers the development workflow, project conventions, and guidelines for submitting changes.

---

## Table of contents

1. [Getting started](#getting-started)
2. [Project structure](#project-structure)
3. [Development workflow](#development-workflow)
4. [Running tests](#running-tests)
5. [Code conventions](#code-conventions)
6. [Environment variable reference](#environment-variable-reference)
7. [Making changes](#making-changes)
8. [Submitting a pull request](#submitting-a-pull-request)

---

## Getting started

### Prerequisites

- **Node.js 20+** (check with `node -v`)
- **npm 10+** (check with `npm -v`)
- **Netlify CLI** — for local development with functions

```sh
npm install -g netlify-cli
```

### Installation

```sh
git clone https://github.com/goldjg/CopeLimit
cd CopeLimit
npm install
```

### Local environment

Create a `.env` file at the project root for local development. The minimum configuration for the mock provider:

```env
COPELIMIT_PROVIDER=mock
SESSION_SECRET=dev-secret-change-in-production
BLOB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

For the full hosted provider (requires a GitHub OAuth App):

```env
COPELIMIT_PROVIDER=github-copilot-internal
SESSION_SECRET=<random-string>
SESSION_ENCRYPTION_KEY=<output of: openssl rand -hex 32>
BLOB_ENCRYPTION_KEY=<output of: openssl rand -hex 32>
GITHUB_CLIENT_ID=<your-app-client-id>
GITHUB_CLIENT_SECRET=<your-app-client-secret>
```

---

## Project structure

```
CopeLimit/
├── netlify/
│   └── functions/
│       ├── lib/                    # Shared backend library code
│       │   ├── __tests__/          # Unit tests for backend libs
│       │   ├── blob-crypto.ts      # AES-256-GCM Blob encryption
│       │   ├── capture-config.ts   # Telemetry capture configuration
│       │   ├── capture-sanitize.ts # Provider response sanitisation
│       │   ├── capture-store.ts    # Blob storage for captures
│       │   ├── capture-types.ts    # Capture subsystem types
│       │   ├── copilot.ts          # Core Usage type + normalisation
│       │   ├── onboarding-store.ts # Bootstrap token storage
│       │   ├── session.ts          # Session cookie helpers
│       │   ├── widget-store.ts     # Widget token Blob storage
│       │   └── widget-token.ts     # Token generation + TTL
│       ├── auth-callback.ts        # GitHub OAuth callback
│       ├── auth-logout.ts          # Session logout
│       ├── auth-start.ts           # GitHub OAuth initiation
│       ├── me.ts                   # Authenticated user info
│       ├── onboarding-exchange.ts  # Bootstrap-to-widget token exchange
│       ├── onboarding-session.ts   # Bootstrap token issuance
│       ├── usage.ts                # Copilot quota endpoint
│       ├── widget-token.ts         # Widget token CRUD
│       └── widget-usage.ts         # Widget-authenticated usage
├── public/
│   ├── icons/                      # PWA icons (generated)
│   ├── scriptable/
│   │   ├── CopeLimitInstall.js     # iOS Scriptable token installer
│   │   └── CopeLimitWidget.js      # iOS Scriptable home-screen widget
│   ├── manifest.webmanifest        # PWA manifest
│   ├── offline.html                # Offline fallback page
│   └── sw.js                       # Service worker
├── scripts/
│   └── generate-icons.mjs          # Icon generation from source PNG
├── src/
│   ├── __tests__/                  # Frontend unit tests
│   ├── main.tsx                    # App entry point
│   ├── WidgetTokenSection.tsx      # Widget token UI component
│   ├── widget-onboarding.ts        # Onboarding state machine (pure)
│   └── styles.css                  # Application styles
├── ARCHITECTURE.md                 # Design and data-flow documentation
├── CONTRIBUTING.md                 # This file
├── README.md                       # Setup and API reference
├── netlify.toml                    # Netlify build + redirect config
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

---

## Development workflow

### Start the local development server

```sh
netlify dev
```

This starts both the Vite dev server and Netlify Functions on `http://localhost:8888`. Hot module replacement is active for the React frontend.

### Build the production bundle

```sh
npm run build
```

Output goes to `dist/`. This directory is ignored by git and should not be committed.

### Regenerate icons

Place a high-resolution square PNG at `app-icon-source.png` then run:

```sh
node scripts/generate-icons.mjs
```

---

## Running tests

```sh
# Run all tests once
npm test

# Run tests in watch mode
npx vitest --watch
```

Tests are co-located with the code they test:

- **Backend lib tests**: `netlify/functions/lib/__tests__/*.test.ts`
- **Frontend tests**: `src/__tests__/*.test.ts`

The test runner is [Vitest](https://vitest.dev/).

### Lint

```sh
npm run lint
```

> **Note**: The linter currently reports `TS5107` for `moduleResolution: Node` (deprecated in TypeScript 5). This is a pre-existing issue unrelated to application functionality. `npm run build` and `npm test` both pass.

---

## Code conventions

### TypeScript

- Strict mode is enabled (`"strict": true` in `tsconfig.json`).
- Prefer `unknown` over `any` for untrusted input.
- Use explicit return types on all exported functions.
- Do not suppress TypeScript errors with `// @ts-ignore` or type assertions unless justified.

### Backend functions

- Each Netlify Function file should export exactly one `handler` function.
- Session verification is done by calling the `requireSession()` local helper pattern (see `widget-token.ts` for the canonical example).
- All error responses should be JSON with an `error` string field.
- Use the `isWidgetStoreNotConfiguredError` / `isWidgetStoreUnavailableError` guards to return `503` responses rather than `500` for expected infrastructure failures.

### Library code

- All public functions must have JSDoc/TSDoc comments.
- New storage operations must use `encryptBlob` / `decryptBlob` — never store sensitive data in plaintext.
- Shared type definitions belong in `copilot.ts` (core types) or domain-specific modules.

### Tests

- Use descriptive `describe` and `it` labels.
- Test the happy path, invalid input, and security-sensitive negative cases.
- Do not mock internal library functions unless unavoidable — prefer testing real behaviour.
- Do not delete or skip existing tests.

### Scriptable scripts

- `CopeLimitWidget.js` and `CopeLimitInstall.js` must remain self-contained (no imports, no `require`).
- Both scripts run in Scriptable's JavaScript runtime; they cannot use Node.js APIs or npm packages.
- All URLs must point to `BASE_URL = "https://copelimit.netlify.app"` (absolute, not relative).
- Changes to these scripts should be tested on a real iOS device before merging.

---

## Environment variable reference

See [README.md — Environment variables](./README.md#environment-variables) for the full reference.

When adding a new environment variable:
1. Document it in `README.md`.
2. Read it defensively (with a sensible default or a clear error message if required).
3. Never log the value of sensitive variables.

---

## Making changes

### Documentation only

When making documentation-only changes, do not modify any TypeScript, JavaScript, or configuration files that affect runtime behaviour.

### Backend changes

1. Update the relevant function handler and/or library module.
2. Add or update unit tests in `netlify/functions/lib/__tests__/`.
3. Run `npm test` and `npm run build` and confirm both pass.
4. Update `README.md` and/or `ARCHITECTURE.md` if the API or data model changed.

### Frontend changes

1. Update the relevant component or module.
2. Add or update tests in `src/__tests__/`.
3. Run `npm test` and `npm run build` and confirm both pass.

### Scriptable script changes

1. Test on a real iOS device with Scriptable installed.
2. Verify that the Fast Setup flow still works end-to-end.
3. Verify that the widget still displays correctly.

---

## Submitting a pull request

1. Fork the repository and create a feature branch from `main`.
2. Follow the code conventions above.
3. Ensure `npm test` and `npm run build` pass.
4. Write a clear PR description explaining **what** changed and **why**.
5. Reference any related issues with `Closes #<issue>` or `Related to #<issue>`.

### Security issues

Please do **not** open public GitHub issues for security vulnerabilities. Instead, report them via GitHub's private vulnerability reporting feature or contact the repository maintainer directly.
