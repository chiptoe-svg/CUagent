/**
 * Granted-scope startup validation.
 *
 * Compares the OAuth scopes actually granted to the configured app
 * against the `denied_scopes` list in the access-permissions data source
 * entry. If any denied scope was granted, the system fails closed in
 * strict mode (refuses to proceed) and warns in telemetry-only mode.
 *
 * The point: even if Mail.Send shows up in the granted token (it
 * shouldn't, given the approved app's manifest, but configurations drift),
 * the policy layer surfaces it loudly rather than silently holding a
 * privilege the workflow doesn't expect to have.
 *
 * Granted scopes are passed in as a string array — the caller is
 * responsible for resolving them from the MSAL token cache (or wherever
 * the per-provider source of truth lives). This module is provider-
 * agnostic regarding how scopes are obtained.
 */
import { logger } from '../logger.js';
import { getConfig } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import type { PolicyDecision } from './types.js';

export interface ScopeValidationResult {
  ok: boolean;
  enforced: boolean;
  warnings: string[];
  /** Subset of grantedScopes that overlap denied_scopes. Empty when ok. */
  violatingScopes: string[];
}

/** Match a granted scope (string) against a deny pattern (string with optional
 *  trailing wildcard `*` or `.*`). Patterns like `Mail.*` match any scope
 *  beginning with `Mail.`. Exact strings match exactly (case-sensitive on
 *  the prefix; Microsoft scope names are case-stable). */
function scopeMatches(granted: string, pattern: string): boolean {
  if (pattern.endsWith('.*') || pattern.endsWith('*')) {
    const prefix = pattern.replace(/\.?\*$/, '');
    return granted === prefix || granted.startsWith(prefix + '.');
  }
  return granted === pattern;
}

/** Normalize a scope string. MSAL tokens may include the resource URI
 *  prefix (`https://graph.microsoft.com/Mail.Read`); deny entries are bare
 *  scope names. Strip the prefix for comparison. */
function normalizeScope(scope: string): string {
  return scope.replace(/^https?:\/\/[^/]+\//, '');
}

export function validateGrantedM365Scopes(
  grantedScopes: string[],
): ScopeValidationResult {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const ms365 = cfg.data_sources.ms365;

  if (!ms365) {
    return {
      ok: false,
      enforced,
      warnings: [
        'access-permissions: data_sources.ms365 entry missing — cannot validate scopes',
      ],
      violatingScopes: [],
    };
  }

  const deniedPatterns = ms365.denied_scopes ?? [];
  if (deniedPatterns.length === 0) {
    return { ok: true, enforced, warnings: [], violatingScopes: [] };
  }

  const normalized = grantedScopes.map(normalizeScope);
  const violating: string[] = [];
  for (const granted of normalized) {
    for (const pattern of deniedPatterns) {
      if (scopeMatches(granted, pattern)) {
        violating.push(granted);
        break;
      }
    }
  }

  if (violating.length > 0) {
    const warnings = violating.map(
      (s) =>
        `granted scope '${s}' matches denied_scopes — narrower than what the policy expects`,
    );
    return {
      ok: false,
      enforced,
      warnings,
      violatingScopes: violating,
    };
  }

  return { ok: true, enforced, warnings: [], violatingScopes: [] };
}

/** Run validateGrantedM365Scopes and act on the result.
 *  Strict mode: throws PolicyDeniedError if any denied scope was granted.
 *  Telemetry-only: logs warnings and returns the result regardless. */
export function enforceGrantedM365Scopes(
  grantedScopes: string[],
): ScopeValidationResult {
  const result = validateGrantedM365Scopes(grantedScopes);
  if (!result.ok) {
    for (const w of result.warnings) {
      logger.warn(
        { violatingScopes: result.violatingScopes },
        `granted-scopes: ${w}`,
      );
    }
    if (result.enforced) {
      const decision: PolicyDecision = {
        allow: false,
        reasonCode: 'ms365_granted_scope_denied',
        message: `granted MSAL scope(s) overlap denied_scopes: ${result.violatingScopes.join(', ')}`,
        enforced: true,
        context: { violatingScopes: result.violatingScopes },
      };
      throw new PolicyDeniedError(decision);
    }
  }
  return result;
}
