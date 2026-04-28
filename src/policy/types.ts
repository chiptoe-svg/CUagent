/**
 * Shared types for the access-permissions policy layer.
 *
 * Mirrors the JSON schema of config/access-permissions.defaults.json (and any
 * local override) without enforcing every field strictly — the loader strips
 * `_doc*` keys and validates required top-level structure, but per-entry
 * shape is loose to allow forward-compatible config additions.
 */

/** A single policy decision, returned by every evaluator. */
export interface PolicyDecision {
  /** True if the operation is permitted. */
  allow: boolean;
  /** Stable machine-readable reason code. Useful for tests and audit logs. */
  reasonCode: string;
  /** Human-readable message including the relevant rationale. */
  message: string;
  /**
   * True when the result will be enforced (institutionSafeMode=true).
   * False in telemetry-only mode (denials log but do not throw).
   */
  enforced: boolean;
  /** Decision context for audit logging. Never includes raw content. */
  context?: Record<string, unknown>;
}

export interface AiProviderEntry {
  allowed: boolean;
  execution?: 'container_only' | 'host';
  rationale?: string;
}

export interface HostAiOperationEntry {
  allowed: boolean;
  endpoint?: string;
  model?: string;
  source?: string;
  source_classification?: string;
  max_body_chars?: number;
  rationale?: string;
}

export interface DataSourceEntry {
  allowed: boolean;
  auth_mode?: string;
  single_tenant_only?: boolean;
  single_account_only?: boolean;
  source_classification?: string;
  scopes_required?: string[];
  denied_scopes?: string[];
  denied_paths?: string[];
  operations?: Record<string, string>;
  rationale?: string;
}

export interface ChannelEntry {
  allowed: boolean;
  mode?: string;
  rationale?: string;
}

export interface AccessPermissionsConfig {
  schemaVersion: number;
  institutionSafeMode: boolean;
  ai_providers: Record<string, AiProviderEntry>;
  host_ai_operations: Record<string, HostAiOperationEntry>;
  data_sources: Record<string, DataSourceEntry>;
  channels: Record<string, ChannelEntry>;
}

/** Context for evaluateHostAiOperation. Each field is optional; the evaluator
 *  enforces only those constraints whose context is supplied. */
export interface HostAiOperationContext {
  endpoint?: string;
  bodyChars?: number;
}
