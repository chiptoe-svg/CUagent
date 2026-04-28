import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  _setAccessPermissionsForTesting,
  enforcePolicy,
  evaluateAiProvider,
  evaluateHostAiOperation,
  getInstitutionSafeMode,
  reloadAccessPermissions,
  _testing,
} from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import type { AccessPermissionsConfig } from './types.js';

const STRICT_BASE: AccessPermissionsConfig = {
  schemaVersion: 1,
  institutionSafeMode: true,
  ai_providers: {
    claude: {
      allowed: true,
      execution: 'container_only',
      rationale: 'test',
    },
    gemini: { allowed: false, rationale: 'test deny' },
  },
  host_ai_operations: {
    email_residual_classifier: {
      allowed: true,
      endpoint: 'api.openai.com',
      max_body_chars: 5000,
    },
  },
  data_sources: {},
  channels: {},
};

const TELEMETRY_BASE: AccessPermissionsConfig = {
  ...STRICT_BASE,
  institutionSafeMode: false,
};

describe('access-permissions', () => {
  afterEach(() => {
    _setAccessPermissionsForTesting(null);
  });

  describe('evaluateAiProvider', () => {
    it('allows a configured allowed provider', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('claude');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('ai_provider_allowed');
      expect(d.enforced).toBe(true);
    });

    it('denies a configured denied provider', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('gemini');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ai_provider_denied');
    });

    it('denies an unknown provider with unknown_ai_provider reason', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('made-up-provider');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('unknown_ai_provider');
    });

    it('reports enforced=false in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      const d = evaluateAiProvider('gemini');
      expect(d.allow).toBe(false);
      expect(d.enforced).toBe(false);
    });
  });

  describe('evaluateHostAiOperation', () => {
    it('allows when endpoint and bodyChars are within bounds', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('email_residual_classifier', {
        endpoint: 'api.openai.com',
        bodyChars: 1000,
      });
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('host_ai_operation_allowed');
    });

    it('denies an unknown operation', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('made-up-op');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('unknown_host_ai_operation');
    });

    it('denies endpoint mismatch', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('email_residual_classifier', {
        endpoint: 'evil.example.com',
      });
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('host_ai_operation_endpoint_mismatch');
    });

    it('denies body exceeding max_body_chars', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('email_residual_classifier', {
        endpoint: 'api.openai.com',
        bodyChars: 999_999,
      });
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('host_ai_operation_body_exceeds_max');
    });

    it('allows when body is exactly at the max', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('email_residual_classifier', {
        endpoint: 'api.openai.com',
        bodyChars: 5000,
      });
      expect(d.allow).toBe(true);
    });

    it('allows when ctx omits the constraint fields the entry would check', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateHostAiOperation('email_residual_classifier');
      expect(d.allow).toBe(true);
    });

    it('denies an explicitly-disallowed operation', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        host_ai_operations: {
          email_residual_classifier: {
            allowed: false,
            rationale: 'turned off for test',
          },
        },
      });
      const d = evaluateHostAiOperation('email_residual_classifier');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('host_ai_operation_denied');
    });
  });

  describe('enforcePolicy', () => {
    it('is a no-op on allow', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('claude');
      expect(() => enforcePolicy(d)).not.toThrow();
    });

    it('throws PolicyDeniedError on deny in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('gemini');
      expect(() => enforcePolicy(d)).toThrow(PolicyDeniedError);
    });

    it('does not throw on deny in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      const d = evaluateAiProvider('gemini');
      expect(() => enforcePolicy(d)).not.toThrow();
    });

    it('attaches the decision to the thrown error', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateAiProvider('gemini');
      try {
        enforcePolicy(d);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyDeniedError);
        expect((err as PolicyDeniedError).decision).toBe(d);
        return;
      }
      throw new Error('expected enforcePolicy to throw');
    });
  });

  describe('getInstitutionSafeMode', () => {
    it('returns true in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(getInstitutionSafeMode()).toBe(true);
    });

    it('returns false in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      expect(getInstitutionSafeMode()).toBe(false);
    });
  });

  describe('loader and merge helpers', () => {
    it('stripDocKeys removes _doc and _doc_<key> entries recursively', () => {
      const input = {
        _doc: 'top-level doc',
        keep: 1,
        nested: {
          _doc_keep: 'nested doc',
          keep: 2,
          deeper: { _doc: 'deep', keep: 3 },
        },
      };
      const stripped = _testing.stripDocKeys(input);
      expect(stripped).toEqual({
        keep: 1,
        nested: { keep: 2, deeper: { keep: 3 } },
      });
    });

    it('deepMerge merges nested objects, overrides win on scalars', () => {
      const base = {
        a: 1,
        b: { x: 1, y: 2 },
        c: ['keep'],
      };
      const override = {
        b: { y: 99, z: 3 },
        c: ['replaced'],
      };
      const merged = _testing.deepMerge(base, override);
      expect(merged).toEqual({
        a: 1,
        b: { x: 1, y: 99, z: 3 },
        c: ['replaced'],
      });
    });

    it('deepMerge replaces arrays wholesale (no concat)', () => {
      const base = { items: ['a', 'b', 'c'] };
      const override = { items: ['x'] };
      expect(_testing.deepMerge(base, override)).toEqual({ items: ['x'] });
    });

    it('validateConfig falls back to fail-closed when required key missing', () => {
      const partial = {
        schemaVersion: 1,
        institutionSafeMode: false,
        ai_providers: {},
        // host_ai_operations / data_sources / channels missing
      };
      const cfg = _testing.validateConfig(partial);
      expect(cfg.institutionSafeMode).toBe(true);
      expect(cfg.ai_providers).toEqual({});
      expect(cfg.host_ai_operations).toEqual({});
    });

    it('failClosedConfig is strict mode with empty registries', () => {
      const cfg = _testing.failClosedConfig();
      expect(cfg.institutionSafeMode).toBe(true);
      expect(Object.keys(cfg.ai_providers)).toHaveLength(0);
      expect(Object.keys(cfg.host_ai_operations)).toHaveLength(0);
    });
  });

  describe('public defaults file', () => {
    it('loads, parses, and validates without errors', () => {
      _setAccessPermissionsForTesting(null);
      reloadAccessPermissions();
      const claude = evaluateAiProvider('claude');
      expect(claude.allow).toBe(true);
      const gemini = evaluateAiProvider('gemini');
      expect(gemini.allow).toBe(false);
    });

    it('email_residual_classifier matches the documented contract', () => {
      _setAccessPermissionsForTesting(null);
      reloadAccessPermissions();
      const allowed = evaluateHostAiOperation('email_residual_classifier', {
        endpoint: 'api.openai.com',
        bodyChars: 4000,
      });
      expect(allowed.allow).toBe(true);

      const wrongEndpoint = evaluateHostAiOperation(
        'email_residual_classifier',
        { endpoint: 'api.evil.com' },
      );
      expect(wrongEndpoint.allow).toBe(false);
      expect(wrongEndpoint.reasonCode).toBe(
        'host_ai_operation_endpoint_mismatch',
      );
    });

    it('public default is telemetry-only (institutionSafeMode=false)', () => {
      _setAccessPermissionsForTesting(null);
      reloadAccessPermissions();
      expect(getInstitutionSafeMode()).toBe(false);
    });
  });
});
