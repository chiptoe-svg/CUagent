import { afterEach, describe, expect, it } from 'vitest';

import { _setAccessPermissionsForTesting } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import { enforceGwsOperation, evaluateGwsOperation } from './gws-operations.js';
import type { AccessPermissionsConfig } from './types.js';

const STRICT_BASE: AccessPermissionsConfig = {
  schemaVersion: 1,
  institutionSafeMode: true,
  ai_providers: {},
  host_ai_operations: {},
  data_sources: {
    gws: {
      allowed: true,
      operations: {
        read_mail: 'allow',
        create_draft: 'allow',
        update_draft: 'allow',
        move_to_ordinary_label: 'allow',
        send_mail: 'deny',
        forward_mail: 'deny',
        delete_mail: 'deny',
        move_to_trash: 'deny',
        move_to_spam: 'deny',
        docs_read: 'allow',
        docs_create: 'allow',
        docs_update: 'allow',
        docs_delete: 'deny',
        sheets_read: 'allow',
        sheets_create: 'allow',
        sheets_update: 'allow',
        sheets_delete: 'deny',
        slides_read: 'allow',
        slides_create: 'allow',
        slides_update: 'allow',
        slides_delete: 'deny',
        drive_list: 'allow',
        drive_read_file: 'allow_with_log',
        drive_write_file: 'deny_unless_doc_sheet_slide',
        drive_share: 'deny',
        drive_make_public: 'deny',
        drive_change_permissions: 'deny',
      },
    },
  },
  channels: {},
};

describe('gws-operations', () => {
  afterEach(() => {
    _setAccessPermissionsForTesting(null);
  });

  describe('evaluateGwsOperation', () => {
    it('allows read_mail', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateGwsOperation('read_mail');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('gws_read_mail_allow');
    });

    it('allows docs_create', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(evaluateGwsOperation('docs_create').allow).toBe(true);
      expect(evaluateGwsOperation('sheets_create').allow).toBe(true);
      expect(evaluateGwsOperation('slides_create').allow).toBe(true);
    });

    it('denies send_mail', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateGwsOperation('send_mail');
      expect(d.allow).toBe(false);
    });

    it('denies move_to_trash', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(evaluateGwsOperation('move_to_trash').allow).toBe(false);
      expect(evaluateGwsOperation('move_to_spam').allow).toBe(false);
      expect(evaluateGwsOperation('delete_mail').allow).toBe(false);
    });

    it('denies docs_delete / sheets_delete / slides_delete', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(evaluateGwsOperation('docs_delete').allow).toBe(false);
      expect(evaluateGwsOperation('sheets_delete').allow).toBe(false);
      expect(evaluateGwsOperation('slides_delete').allow).toBe(false);
    });

    it('drive_list allowed; drive_read_file allowed-with-log', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(evaluateGwsOperation('drive_list').allow).toBe(true);
      const read = evaluateGwsOperation('drive_read_file');
      expect(read.allow).toBe(true);
      expect(read.reasonCode).toBe('gws_drive_read_file_allow_with_log');
    });

    it('drive_write_file denied (deny_unless_doc_sheet_slide treated as deny)', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateGwsOperation('drive_write_file');
      expect(d.allow).toBe(false);
    });

    it('drive_share / drive_make_public / drive_change_permissions all denied', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(evaluateGwsOperation('drive_share').allow).toBe(false);
      expect(evaluateGwsOperation('drive_make_public').allow).toBe(false);
      expect(evaluateGwsOperation('drive_change_permissions').allow).toBe(
        false,
      );
    });

    it('denies all when gws entry is allowed=false', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        data_sources: {
          gws: { ...STRICT_BASE.data_sources.gws, allowed: false },
        },
      });
      const d = evaluateGwsOperation('read_mail');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('gws_denied');
    });

    it('denies all when gws entry is missing', () => {
      _setAccessPermissionsForTesting({ ...STRICT_BASE, data_sources: {} });
      const d = evaluateGwsOperation('read_mail');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('gws_not_in_registry');
    });
  });

  describe('enforceGwsOperation', () => {
    it('throws on deny in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceGwsOperation('send_mail')).toThrow(PolicyDeniedError);
    });

    it('does not throw on allow', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceGwsOperation('read_mail')).not.toThrow();
    });

    it('does not throw on deny in telemetry-only mode', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        institutionSafeMode: false,
      });
      expect(() => enforceGwsOperation('drive_share')).not.toThrow();
    });
  });
});
