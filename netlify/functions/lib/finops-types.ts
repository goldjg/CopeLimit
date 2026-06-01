/**
 * @file FinOps and AADLC attribution domain types for CopeLimit Horizon 3.
 *
 * This module contains TypeScript type definitions only. It has no runtime
 * behaviour, no I/O, and no validation logic.
 *
 * SECURITY / PRIVACY WARNING — manifests, checkpoints, and attribution records
 * produced against these types MUST NOT contain:
 *   - secrets, tokens, cookies, encryption keys, or OAuth credentials
 *   - raw provider API payloads or raw GitHub usage report data
 *   - file contents or command stdout/stderr output
 *   - personally identifiable information beyond a GitHub repository slug
 */

/** Schema version token for FinOps records in this release. */
export type FinOpsSchemaVersion = '0.1'

/** The overall classification of an AADLC agent run. */
export type AADLCRunType =
  | 'planning'
  | 'implementation'
  | 'review_fix'
  | 'investigation'
  | 'debugging'
  | 'documentation'
  | 'mixed'
  | 'unknown'

/** The phase classification within a single AADLC run. */
export type AADLCPhaseType =
  | 'hydration'
  | 'planning'
  | 'implementation'
  | 'test_debug'
  | 'review_fix'
  | 'docs'
  | 'validation'
  | 'user_steering'
  | 'pr_creation'
  | 'unknown'

/** Confidence level for an attribution claim. */
export type AttributionConfidence =
  | 'observed'
  | 'declared'
  | 'inferred'
  | 'unknown'

/** Whether the usage interval may include activity outside this run. */
export type ContaminationStatus =
  | 'clean'
  | 'overlapped'
  | 'external_activity'
  | 'unknown'

/** How a UsageCheckpoint was produced. */
export type CheckpointSource =
  | 'copelimit_live'
  | 'github_ui'
  | 'github_report'
  | 'manual'
  | 'unknown'

/** Reliability of a UsageCheckpoint value. */
export type CheckpointConfidence = 'high' | 'medium' | 'low' | 'unknown'

/** Whether a UsageCheckpoint reflects the current quota state. */
export type CheckpointFreshness = 'fresh' | 'stale' | 'unknown'

/** Billing mode active when a checkpoint was captured. */
export type CheckpointMode = 'ai_credits' | 'premium_requests' | 'unknown'

/** Validation outcome recorded without storing raw command output. */
export interface ValidationResult {
  /** Name of the check that was run. */
  check: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Optional brief summary with no raw output. */
  summary?: string;
}

/**
 * A point-in-time snapshot of Copilot quota state.
 *
 * UsageCheckpoint is first-class and is not embedded inside manifests.
 */
export interface UsageCheckpoint {
  /** Stable unique identifier for this checkpoint. */
  checkpointId: string;
  /** Optional UsageContext identifier for future multi-context support. */
  usageContextId?: string;
  /** How this checkpoint was obtained. */
  source: CheckpointSource;
  /** Optional free-text clarification of the source. */
  sourceDetail?: string;
  /** Remaining quota at the time of capture. */
  remaining: number;
  /** Used quota at the time of capture. */
  used: number;
  /** Total quota allocated at the time of capture. */
  quota: number;
  /** Billing mode active at the time of capture. */
  mode: CheckpointMode;
  /** ISO 8601 timestamp when the quota period resets. */
  resetAt?: string;
  /** ISO 8601 timestamp when this checkpoint was captured. */
  capturedAt: string;
  /** Reliability of this checkpoint's values. */
  confidence: CheckpointConfidence;
  /** Whether this checkpoint is still timely for attribution use. */
  freshness: CheckpointFreshness;
  /** Optional human-authored notes about the checkpoint. */
  notes?: string;
}

/**
 * A single phase within an AADLC run.
 *
 * This records high-level metadata only.
 */
export interface AADLCPhaseEvent {
  /** Stable unique identifier for this phase. */
  phaseId: string;
  /** Human-readable label for this phase. */
  phaseName: string;
  /** Functional classification of this phase. */
  phaseType: AADLCPhaseType;
  /** ISO 8601 timestamp when this phase started. */
  startedAt?: string;
  /** ISO 8601 timestamp when this phase ended. */
  endedAt?: string;
  /** checkpointId of the checkpoint taken before this phase. */
  beforeCheckpointId?: string;
  /** checkpointId of the checkpoint taken after this phase. */
  afterCheckpointId?: string;
  /** High-level action labels performed in this phase. */
  actions?: string[];
  /** File paths read during this phase; paths only, no content. */
  filesRead?: string[];
  /** File paths changed during this phase; paths only, no content. */
  filesChanged?: string[];
  /** Command or tool labels invoked during this phase; no output. */
  commandsRun?: string[];
  /** Attribution confidence declared by the agent for this phase. */
  attributionConfidenceDeclared?: AttributionConfidence;
  /** Contamination status declared by the agent for this phase. */
  contaminationStatusDeclared?: ContaminationStatus;
  /** Optional caveats about the phase or its attribution quality. */
  notesCaveats?: string[];
}

/**
 * An agent-authored run manifest for AADLC cost attribution metadata.
 *
 * Manifests must not contain secrets, raw payloads, raw usage reports,
 * file contents, command stdout/stderr, cookies, tokens, or encryption keys.
 */
export interface AADLCRunManifest {
  /** Schema version for this manifest. */
  schemaVersion: FinOpsSchemaVersion;
  /** Stable unique identifier for this manifest. */
  manifestId: string;
  /** Optional plan identifier governing this run. */
  planId?: string;
  /** Repository slug in owner/repo form. */
  repo: string;
  /** Branch targeted by this run, when known. */
  branch?: string;
  /** Pull request number associated with this run, when known. */
  prNumber?: number;
  /** Pull request URL associated with this run, when known. */
  prUrl?: string;
  /** Overall classification of the run. */
  runType: AADLCRunType;
  /** Short human-readable title for the task. */
  taskTitle: string;
  /** Concise statement of the task objective. */
  taskIntent: string;
  /** ISO 8601 timestamp when the run started. */
  startedAt?: string;
  /** ISO 8601 timestamp when the run ended. */
  endedAt?: string;
  /** Model identifier declared by the agent, when available. */
  modelDeclared?: string;
  /** checkpointId of the checkpoint taken before the run began. */
  beforeCheckpointId?: string;
  /** checkpointId of the checkpoint taken after the run ended. */
  afterCheckpointId?: string;
  /** File paths read across the run; paths only, no content. */
  filesRead?: string[];
  /** File paths changed across the run; paths only, no content. */
  filesChanged?: string[];
  /** Command or tool labels invoked across the run; no output. */
  commandsRun?: string[];
  /** Validation outcomes recorded without raw output. */
  validationResults?: ValidationResult[];
  /** Ordered list of phases nested within this run. */
  phases?: AADLCPhaseEvent[];
  /** Explicit non-goals declared for this run. */
  explicitNonGoals?: string[];
  /** High-level labels describing user steering events. */
  userSteeringEvents?: string[];
  /** Attribution confidence declared by the agent for the overall run. */
  attributionConfidenceDeclared?: AttributionConfidence;
  /** Contamination status declared by the agent for the overall run. */
  contaminationStatusDeclared?: ContaminationStatus;
  /** Optional caveats about attribution quality or missing context. */
  notesCaveats?: string[];
  /** ISO 8601 timestamp when this manifest was emitted. */
  emittedAt: string;
}

/**
 * A CopeLimit-derived attribution record computed after manifest ingestion.
 *
 * Agents must not author AttributionRecord objects directly.
 */
export interface AttributionRecord {
  /** Stable unique identifier for this attribution record. */
  attributionId: string;
  /** Manifest identifier the record was derived from, when applicable. */
  manifestId?: string;
  /** Phase identifier the record was derived from, when applicable. */
  phaseId?: string;
  /** checkpointId of the before-run checkpoint. */
  beforeCheckpointId?: string;
  /** checkpointId of the after-run checkpoint. */
  afterCheckpointId?: string;
  /** Computed usage delta, when both checkpoints are available. */
  creditDelta?: number;
  /** Confidence level for the attribution result. */
  confidence: AttributionConfidence;
  /** Whether the interval may include unrelated activity. */
  contaminationStatus: ContaminationStatus;
  /** ISO 8601 timestamp when CopeLimit created this record. */
  createdAt: string;
  /** Optional notes about derivation or caveats. */
  notes?: string[];
}
