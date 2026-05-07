/**
 * CopeLimit Scriptable token configuration script.
 *
 * @description
 * Exchanges a short-lived bootstrap token for a long-lived widget bearer token
 * and stores the result in the iOS Keychain under `"copelimit_widget_token"`.
 *
 * This script is **not intended to be run manually**. It is invoked
 * automatically by the `CopeLimitInstaller` iOS Shortcut as part of the Fast
 * Setup onboarding flow from the CopeLimit PWA.
 *
 * ## Input sources (tried in order)
 * 1. `args.queryParameters.bt` — bootstrap token supplied as a URL parameter
 *    when launched via `scriptable:///run?scriptName=CopeLimitInstall&bt=<token>`.
 * 2. `Script.parameter()` — JSON string `{ bootstrapToken, callbackUrl, ... }`
 *    passed by the iOS Shortcut from the clipboard.
 * 3. `Script.parameter()` — treated as a raw bootstrap token string (fallback).
 *
 * ## Flow
 * 1. Parse the bootstrap token from the available input source.
 * 2. `POST /api/onboarding/exchange` with `{ bootstrapToken }`.
 * 3. On success: store `widgetToken` in Keychain, redirect to `callbackUrl`.
 * 4. On error: redirect to `/?onboarding=error&reason=<reason>`.
 *
 * ## Security
 * - The `callbackUrl` is validated against `BASE_URL` before any redirect to
 *   prevent open-redirect attacks.
 * - The bootstrap token is single-use: the exchange endpoint consumes it
 *   immediately so it cannot be replayed.
 */

// CopeLimit Scriptable token configuration script.
// Imported and run from CopeLimit iPhone onboarding.

const BASE_URL = "https://copelimit.netlify.app";

function safeCallbackUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return `${BASE_URL}/?onboarding=complete`;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.origin === BASE_URL) {
      return parsed.toString();
    }
  } catch {
    // Fall through to default callback URL.
  }

  return `${BASE_URL}/?onboarding=complete`;
}

function parseInstallerInput() {
  const parameter = typeof Script !== "undefined" && typeof Script.parameter === "function" ? Script.parameter() : "";
  const query = args && typeof args === "object" && args.queryParameters ? args.queryParameters : {};
  const queryBootstrapToken = typeof query.bt === "string" ? query.bt : "";
  const queryCallbackUrl = typeof query.callbackUrl === "string" ? query.callbackUrl : "";

  if (typeof queryBootstrapToken === "string" && queryBootstrapToken.length > 0) {
    return {
      bootstrapToken: queryBootstrapToken,
      callbackUrl: safeCallbackUrl(queryCallbackUrl)
    };
  }

  if (typeof parameter === "string" && parameter.length > 0) {
    try {
      const parsed = JSON.parse(parameter);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const bootstrapToken = typeof parsed.bootstrapToken === "string" ? parsed.bootstrapToken : "";
        const callbackUrl = typeof parsed.callbackUrl === "string" ? parsed.callbackUrl : queryCallbackUrl;
        if (bootstrapToken) {
          return {
            bootstrapToken,
            callbackUrl: safeCallbackUrl(callbackUrl)
          };
        }
      }
    } catch {
      // Non-JSON parameter can still be a raw bootstrap token.
    }

    return {
      bootstrapToken: parameter,
      callbackUrl: safeCallbackUrl(queryCallbackUrl)
    };
  }

  return {
    bootstrapToken: "",
    callbackUrl: safeCallbackUrl(queryCallbackUrl)
  };
}

async function main() {
  const { bootstrapToken, callbackUrl } = parseInstallerInput();

  if (!bootstrapToken) {
    const alert = new Alert();
    alert.title = "CopeLimit token setup failed";
    alert.message = "Missing Token setup code. Return to CopeLimit and try again.";
    alert.addAction("OK");
    await alert.present();
    Safari.open(`${BASE_URL}/?onboarding=error&reason=missing_token`);
    return;
  }

  try {
    const request = new Request(`${BASE_URL}/api/onboarding/exchange`);
    request.method = "POST";
    request.headers = {
      "content-type": "application/json",
      accept: "application/json"
    };
    request.body = JSON.stringify({ bootstrapToken });

    const raw = await request.loadString();
    let response = null;
    try {
      response = JSON.parse(raw);
    } catch {
      Safari.open(`${BASE_URL}/?onboarding=error&reason=invalid_response`);
      return;
    }

    if (request.response?.statusCode >= 400) {
      const reason = encodeURIComponent((response && response.error) || `http_${request.response?.statusCode || "error"}`);
      Safari.open(`${BASE_URL}/?onboarding=error&reason=${reason}`);
      return;
    }

    if (!response || typeof response.widgetToken !== "string") {
      const reason = encodeURIComponent((response && response.error) || "exchange_failed");
      Safari.open(`${BASE_URL}/?onboarding=error&reason=${reason}`);
      return;
    }

    Keychain.set("copelimit_widget_token", response.widgetToken);
    Safari.open(callbackUrl);
  } catch {
    Safari.open(`${BASE_URL}/?onboarding=error&reason=network`);
  }
}

await main();
Script.complete();
