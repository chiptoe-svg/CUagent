import { afterEach, describe, expect, it } from 'vitest';

import { _setAccessPermissionsForTesting } from './access-permissions.js';
import {
  enforceChannel,
  enforceDataSource,
  evaluateChannel,
  evaluateDataSource,
} from './activation.js';
import { PolicyDeniedError } from './errors.js';
import type { AccessPermissionsConfig } from './types.js';

const STRICT_BASE: AccessPermissionsConfig = {
  schemaVersion: 1,
  institutionSafeMode: true,
  ai_providers: {},
  host_ai_operations: {},
  data_sources: {
    ms365: { allowed: true, rationale: 'test' },
    gws: { allowed: true, rationale: 'test' },
    imap: { allowed: false, rationale: 'denied test' },
  },
  channels: {
    telegram: {
      allowed: true,
      mode: 'self_only_main_group',
      rationale: 'test',
    },
    slack: { allowed: false, rationale: 'denied test' },
  },
};

const TELEMETRY_BASE: AccessPermissionsConfig = {
  ...STRICT_BASE,
  institutionSafeMode: false,
};

describe('activation policy', () => {
  afterEach(() => {
    _setAccessPermissionsForTesting(null);
  });

  describe('evaluateChannel', () => {
    it('allows a configured allowed channel', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateChannel('telegram');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('channel_allowed');
      expect(d.context?.mode).toBe('self_only_main_group');
    });

    it('denies a configured denied channel', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateChannel('slack');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('channel_denied');
    });

    it('denies an unknown channel', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateChannel('made-up-channel');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('unknown_channel');
    });

    it('reports enforced=false in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      const d = evaluateChannel('slack');
      expect(d.allow).toBe(false);
      expect(d.enforced).toBe(false);
    });
  });

  describe('enforceChannel', () => {
    it('throws PolicyDeniedError on deny in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceChannel('slack')).toThrow(PolicyDeniedError);
    });

    it('does not throw on allow', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceChannel('telegram')).not.toThrow();
    });

    it('does not throw on deny in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      expect(() => enforceChannel('slack')).not.toThrow();
    });
  });

  describe('evaluateDataSource', () => {
    it('allows a configured allowed source', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateDataSource('ms365');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('data_source_allowed');
    });

    it('denies a configured denied source', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateDataSource('imap');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('data_source_denied');
    });

    it('denies an unknown source (e.g., gws_mcp not in registry)', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateDataSource('gws_mcp');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('unknown_data_source');
    });
  });

  describe('enforceDataSource', () => {
    it('throws on deny in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceDataSource('imap')).toThrow(PolicyDeniedError);
    });

    it('does not throw on allow', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceDataSource('ms365')).not.toThrow();
    });

    it('does not throw on deny in telemetry-only mode', () => {
      _setAccessPermissionsForTesting(TELEMETRY_BASE);
      expect(() => enforceDataSource('imap')).not.toThrow();
    });
  });

  describe('public defaults', () => {
    it('telegram is allowed under public defaults', () => {
      _setAccessPermissionsForTesting(null);
      const d = evaluateChannel('telegram');
      expect(d.allow).toBe(true);
    });

    it('slack is denied under public defaults', () => {
      _setAccessPermissionsForTesting(null);
      const d = evaluateChannel('slack');
      expect(d.allow).toBe(false);
    });

    it('ms365 is allowed under public defaults', () => {
      _setAccessPermissionsForTesting(null);
      const d = evaluateDataSource('ms365');
      expect(d.allow).toBe(true);
    });

    it('teams_chat is denied under public defaults', () => {
      _setAccessPermissionsForTesting(null);
      const d = evaluateDataSource('teams_chat');
      expect(d.allow).toBe(false);
    });
  });
});
