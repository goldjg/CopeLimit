import type { Handler } from '@netlify/functions';
import {
  isOnboardingStoreNotConfiguredError,
  isOnboardingStoreUnavailableError,
  resolveAndConsumeBootstrapToken
} from './lib/onboarding-store';
import { issueWidgetTokenForUser, isWidgetStoreNotConfiguredError, isWidgetStoreUnavailableError } from './lib/widget-store';
import { widgetTokenTtlDays } from './lib/widget-token';

type ExchangeRequestBody = {
  bootstrapToken?: unknown;
};

function parseJsonBody(event: Parameters<Handler>[0]): ExchangeRequestBody | null {
  if (!event.body) return null;

  try {
    const decoded = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(decoded) as ExchangeRequestBody;
  } catch {
    return null;
  }
}

function validBootstrapToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export const handler: Handler = async (event) => {
  const baseHeaders = { 'content-type': 'application/json; charset=utf-8' };

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const body = parseJsonBody(event);
  if (!body || !validBootstrapToken(body.bootstrapToken)) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Invalid request body' })
    };
  }

  try {
    const bootstrapRecord = await resolveAndConsumeBootstrapToken(body.bootstrapToken);
    if (!bootstrapRecord) {
      return {
        statusCode: 401,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid, expired, or already-used bootstrap token' })
      };
    }

    const issued = await issueWidgetTokenForUser({
      id: bootstrapRecord.userId,
      login: bootstrapRecord.login,
      accessToken: bootstrapRecord.githubAccessToken,
      avatar_url: ''
    });

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        widgetToken: issued.token,
        expiresAt: issued.record.expiresAt,
        ttlDays: widgetTokenTtlDays(),
        login: bootstrapRecord.login
      })
    };
  } catch (error) {
    if (isOnboardingStoreNotConfiguredError(error) || isWidgetStoreNotConfiguredError(error)) {
      return {
        statusCode: 503,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Service not configured' })
      };
    }

    if (isOnboardingStoreUnavailableError(error) || isWidgetStoreUnavailableError(error)) {
      return {
        statusCode: 503,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Onboarding storage is unavailable' })
      };
    }

    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
