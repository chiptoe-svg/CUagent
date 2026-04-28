import { afterEach, describe, expect, it } from 'vitest';

import { _setAccessPermissionsForTesting } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import {
  enforceGrantedM365Scopes,
  validateGrantedM365Scopes,
} from './granted-scopes.js';
import type { AccessPermissionsConfig } from './types.js';

const BASE: AccessPermissionsConfig = {
  schemaVersion: 1,
  institutionSafeMode: true,
  ai_providers: {},
  host_ai_operations: {},
  data_sources: {
    ms365: {
      allowed: true,
      denied_scopes: [
        'Mail.Send',
        'Mail.Send.Shared',
        'Mail.Read.Shared',
        'Mail.ReadWrite.Shared',
        'Chat.*',
        'Files.*',
        'Sites.*',
        'User.Read.All',
        'Directory.Read.All',
      ],
    },
  },
  channels: {},
};

describe('granted-scopes', () => {
  afterEach(() => {
    _setAccessPermissionsForTesting(null);
  });

  describe('validateGrantedM365Scopes', () => {
    it('returns ok when no granted scopes overlap denied list', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes([
        'User.Read',
        'Mail.ReadWrite',
        'Calendars.ReadWrite',
        'Tasks.ReadWrite',
      ]);
      expect(r.ok).toBe(true);
      expect(r.violatingScopes).toEqual([]);
    });

    it('flags exact denied scope match', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes(['Mail.ReadWrite', 'Mail.Send']);
      expect(r.ok).toBe(false);
      expect(r.violatingScopes).toContain('Mail.Send');
    });

    it('flags wildcard pattern matches (Chat.*, Files.*)', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes([
        'Mail.ReadWrite',
        'Chat.Read',
        'Files.ReadWrite.All',
      ]);
      expect(r.ok).toBe(false);
      expect(r.violatingScopes).toContain('Chat.Read');
      expect(r.violatingScopes).toContain('Files.ReadWrite.All');
    });

    it('strips Graph URI prefix before comparison', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes([
        'https://graph.microsoft.com/Mail.Send',
      ]);
      expect(r.ok).toBe(false);
      expect(r.violatingScopes).toEqual(['Mail.Send']);
    });

    it('does not flag unrelated scopes that share a prefix', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes([
        'Mail.ReadWrite',
        'Mail.Read',
        'User.Read',
      ]);
      expect(r.ok).toBe(true);
    });

    it('reports enforced flag from config', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = validateGrantedM365Scopes(['Mail.ReadWrite']);
      expect(r.enforced).toBe(true);

      _setAccessPermissionsForTesting({ ...BASE, institutionSafeMode: false });
      const r2 = validateGrantedM365Scopes(['Mail.ReadWrite']);
      expect(r2.enforced).toBe(false);
    });

    it('returns ok=true when denied_scopes is empty', () => {
      _setAccessPermissionsForTesting({
        ...BASE,
        data_sources: { ms365: { allowed: true, denied_scopes: [] } },
      });
      const r = validateGrantedM365Scopes(['Mail.Send']);
      expect(r.ok).toBe(true);
    });
  });

  describe('enforceGrantedM365Scopes', () => {
    it('throws PolicyDeniedError in strict mode when denied scope granted', () => {
      _setAccessPermissionsForTesting(BASE);
      expect(() =>
        enforceGrantedM365Scopes(['Mail.ReadWrite', 'Mail.Send']),
      ).toThrow(PolicyDeniedError);
    });

    it('does not throw in telemetry-only mode', () => {
      _setAccessPermissionsForTesting({ ...BASE, institutionSafeMode: false });
      expect(() =>
        enforceGrantedM365Scopes(['Mail.ReadWrite', 'Mail.Send']),
      ).not.toThrow();
    });

    it('returns the validation result on either mode', () => {
      _setAccessPermissionsForTesting({ ...BASE, institutionSafeMode: false });
      const r = enforceGrantedM365Scopes(['Mail.ReadWrite', 'Mail.Send']);
      expect(r.ok).toBe(false);
      expect(r.violatingScopes).toContain('Mail.Send');
    });

    it('returns ok=true when granted scopes are clean', () => {
      _setAccessPermissionsForTesting(BASE);
      const r = enforceGrantedM365Scopes([
        'Mail.ReadWrite',
        'Calendars.ReadWrite',
      ]);
      expect(r.ok).toBe(true);
    });
  });
});
