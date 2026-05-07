import type { JsonObject, Usage } from './copilot'

export type CaptureConfig = {
  enabled: boolean;
  retentionDays: number;
  maxPerDay: number;
  includeNormalized: boolean;
}

export type SanitizedPayload = JsonObject & {
  _rawFieldNames: string[];
  _unknown_fields: string[];
}

export type CapturedNormalizedUsage = Omit<Usage, 'billingEntity'>

export type ProviderCapture = {
  captureVersion: '1';
  capturedAt: string;
  provider: string;
  userId: number;
  normalized?: CapturedNormalizedUsage;
  sanitizedRaw: SanitizedPayload;
  meta: {
    responseHttpStatus?: number;
    captureSchemaVersion: '1';
    includesNormalized: boolean;
    sanitizerVersion: '1';
  };
}

export type CaptureIndex = {
  count: number;
  date: string;
}
