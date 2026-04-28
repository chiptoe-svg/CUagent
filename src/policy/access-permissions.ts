/**
 * Access-permissions policy module.
 *
 * Loads `config/access-permissions.defaults.json` (public, conservative) and
 * deep-merges any `config/access-permissions.local.json` (gitignored,
 * per-install override) on top. Exposes evaluators for the four axes — the
 * AI-provider gate at runtime selection and the host-AI-operation gate at
 * each direct host-to-AI call site are wired in this phase. Data-source and
 * channel evaluators land in subsequent phases against the same loaded
 * config.
 *
 * Decisions return a PolicyDecision rather than throwing; enforcePolicy is
 * the helper that converts a denied decision into a thrown PolicyDeniedError
 * (strict mode) or a logged would-be-denial (telemetry-only mode). Callers
 * with a graceful skip path may inspect decision.allow directly without
 * going through enforcePolicy.
 *
 * Fail-closed posture on loader errors: a missing or malformed defaults
 * file collapses to an empty config with institutionSafeMode=true, so a
 * misconfigured install denies everything rather than allowing everything.
 *
 * See docs/INSTITUTION_SAFE_MODE.md for the full posture and
 * config/access-permissions.defaults.json for the schema reference.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { PolicyDeniedError } from './errors.js';
import type {
  AccessPermissionsConfig,
  HostAiOperationContext,
  PolicyDecision,
} from './types.js';

const DEFAULTS_PATH = path.join(
  process.cwd(),
  'config',
  'access-permissions.defaults.json',
);
const LOCAL_PATH = path.join(
  process.cwd(),
  'config',
  'access-permissions.local.json',
);

let cachedConfig: AccessPermissionsConfig | null = null;

/** Strip `_doc*` keys recursively. The defaults file uses `_doc` /
 *  `_doc_<key>` for inline documentation; those are not part of the runtime
 *  schema and must not appear in the merged config. */
function stripDocKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripDocKeys);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_doc') || k === '_example_env_settings') continue;
      out[k] = stripDocKeys(v);
    }
    return out;
  }
  return obj;
}

/** Recursive merge: object values merge, scalars and arrays from override
 *  win. Arrays are replaced wholesale (not concatenated) so a local override
 *  can shrink an allowlist if needed. */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown> | undefined,
): T {
  if (!override) return base;
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = result[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[k] = deepMerge(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

function failClosedConfig(): AccessPermissionsConfig {
  return {
    schemaVersion: 1,
    institutionSafeMode: true,
    ai_providers: {},
    host_ai_operations: {},
    data_sources: {},
    channels: {},
  };
}

function validateConfig(cfg: unknown): AccessPermissionsConfig {
  if (!cfg || typeof cfg !== 'object') return failClosedConfig();
  const c = cfg as Partial<AccessPermissionsConfig>;
  const required = [
    'schemaVersion',
    'institutionSafeMode',
    'ai_providers',
    'host_ai_operations',
    'data_sources',
    'channels',
  ] as const;
  for (const key of required) {
    if (!(key in c)) {
      logger.error(
        { missing: key },
        'access-permissions: required field missing from config, fail-closed',
      );
      return failClosedConfig();
    }
  }
  return c as AccessPermissionsConfig;
}

function loadAndMergeConfig(
  defaultsPath: string = DEFAULTS_PATH,
  localPath: string = LOCAL_PATH,
): AccessPermissionsConfig {
  let defaults: unknown;
  try {
    defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
  } catch (err) {
    logger.error(
      { err, path: defaultsPath },
      'access-permissions: defaults file not readable, fail-closed config',
    );
    return failClosedConfig();
  }

  const stripped = stripDocKeys(defaults) as Record<string, unknown>;

  let merged = stripped;
  if (fs.existsSync(localPath)) {
    try {
      const localRaw = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      const localStripped = stripDocKeys(localRaw) as Record<string, unknown>;
      merged = deepMerge(stripped, localStripped);
      logger.info(
        {
          path: localPath,
          mode: merged.institutionSafeMode ? 'strict' : 'telemetry-only',
        },
        'access-permissions: merged local override',
      );
    } catch (err) {
      logger.warn(
        { err, path: localPath },
        'access-permissions: local override exists but unreadable, using defaults only',
      );
    }
  } else {
    logger.info(
      {
        mode: merged.institutionSafeMode ? 'strict' : 'telemetry-only',
      },
      'access-permissions: no local override, using public defaults',
    );
  }

  return validateConfig(merged);
}

function getConfig(): AccessPermissionsConfig {
  if (cachedConfig === null) {
    cachedConfig = loadAndMergeConfig();
  }
  return cachedConfig;
}

/** Force reload from disk on next access. Useful for tests and for live
 *  config edits during development. */
export function reloadAccessPermissions(): void {
  cachedConfig = null;
}

/** Inject a config directly, bypassing filesystem reads. Tests use this for
 *  fast, isolated assertions without touching the real config files. */
export function _setAccessPermissionsForTesting(
  cfg: AccessPermissionsConfig | null,
): void {
  cachedConfig = cfg;
}

export function getInstitutionSafeMode(): boolean {
  return getConfig().institutionSafeMode;
}

/** Evaluate whether a runtime / AI provider is permitted to spawn. */
export function evaluateAiProvider(providerId: string): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const entry = cfg.ai_providers[providerId];

  if (!entry) {
    return {
      allow: false,
      reasonCode: 'unknown_ai_provider',
      message: `AI provider '${providerId}' is not in access-permissions registry`,
      enforced,
      context: { providerId },
    };
  }

  if (!entry.allowed) {
    return {
      allow: false,
      reasonCode: 'ai_provider_denied',
      message: `AI provider '${providerId}' is denied: ${entry.rationale ?? 'no rationale provided'}`,
      enforced,
      context: { providerId, rationale: entry.rationale },
    };
  }

  return {
    allow: true,
    reasonCode: 'ai_provider_allowed',
    message: `AI provider '${providerId}' allowed`,
    enforced,
    context: { providerId, execution: entry.execution },
  };
}

/** Evaluate whether a direct host-to-AI call is permitted. */
export function evaluateHostAiOperation(
  operationId: string,
  ctx: HostAiOperationContext = {},
): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const entry = cfg.host_ai_operations[operationId];

  if (!entry) {
    return {
      allow: false,
      reasonCode: 'unknown_host_ai_operation',
      message: `Host AI operation '${operationId}' is not in access-permissions registry`,
      enforced,
      context: { operationId },
    };
  }

  if (!entry.allowed) {
    return {
      allow: false,
      reasonCode: 'host_ai_operation_denied',
      message: `Host AI operation '${operationId}' is denied: ${entry.rationale ?? 'no rationale provided'}`,
      enforced,
      context: { operationId },
    };
  }

  if (entry.endpoint && ctx.endpoint && entry.endpoint !== ctx.endpoint) {
    return {
      allow: false,
      reasonCode: 'host_ai_operation_endpoint_mismatch',
      message: `Host AI operation '${operationId}' endpoint mismatch: configured '${entry.endpoint}', requested '${ctx.endpoint}'`,
      enforced,
      context: {
        operationId,
        configuredEndpoint: entry.endpoint,
        requestedEndpoint: ctx.endpoint,
      },
    };
  }

  if (
    entry.max_body_chars != null &&
    ctx.bodyChars != null &&
    ctx.bodyChars > entry.max_body_chars
  ) {
    return {
      allow: false,
      reasonCode: 'host_ai_operation_body_exceeds_max',
      message: `Host AI operation '${operationId}' body of ${ctx.bodyChars} chars exceeds configured max ${entry.max_body_chars}`,
      enforced,
      context: {
        operationId,
        bodyChars: ctx.bodyChars,
        maxBodyChars: entry.max_body_chars,
      },
    };
  }

  return {
    allow: true,
    reasonCode: 'host_ai_operation_allowed',
    message: `Host AI operation '${operationId}' allowed`,
    enforced,
    context: { operationId },
  };
}

/**
 * Convert a PolicyDecision into runtime behavior:
 *   - allow → no-op.
 *   - deny + enforced (strict mode) → logs and throws PolicyDeniedError.
 *   - deny + !enforced (telemetry-only) → logs would-be-denial and returns.
 *
 * Callers with a graceful skip path may bypass enforcePolicy and inspect
 * decision.allow / decision.enforced directly. enforcePolicy is the right
 * tool when there is no graceful skip and the operation should hard-stop
 * in strict mode.
 */
export function enforcePolicy(decision: PolicyDecision): void {
  if (decision.allow) return;
  if (decision.enforced) {
    logger.warn(
      {
        reasonCode: decision.reasonCode,
        context: decision.context,
      },
      `access-permissions: ${decision.message}`,
    );
    throw new PolicyDeniedError(decision);
  }
  logger.warn(
    {
      reasonCode: decision.reasonCode,
      context: decision.context,
    },
    `access-permissions: would have denied (telemetry-only): ${decision.message}`,
  );
}

/** Test-only helper: load a config from explicit paths (bypasses cache). */
export const _testing = {
  loadAndMergeConfig,
  stripDocKeys,
  deepMerge,
  failClosedConfig,
  validateConfig,
  DEFAULTS_PATH,
  LOCAL_PATH,
};
