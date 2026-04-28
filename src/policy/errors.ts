/**
 * PolicyDeniedError — thrown by enforcePolicy() when a decision is denied
 * AND institutionSafeMode is true (strict). In telemetry-only mode,
 * enforcePolicy logs but does not throw.
 *
 * The full PolicyDecision is attached for audit logging and for callers
 * that want to surface the reason to the user.
 */
import type { PolicyDecision } from './types.js';

export class PolicyDeniedError extends Error {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(`Policy denied: ${decision.message}`);
    this.name = 'PolicyDeniedError';
    this.decision = decision;
  }
}
