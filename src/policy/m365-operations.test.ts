import { afterEach, describe, expect, it } from 'vitest';

import { _setAccessPermissionsForTesting } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import {
  classifyDestinationFolder,
  classifyGraphPath,
  enforceM365Operation,
  enforceM365Path,
  evaluateM365Operation,
  type M365Operation,
} from './m365-operations.js';
import type { AccessPermissionsConfig } from './types.js';

const STRICT_BASE: AccessPermissionsConfig = {
  schemaVersion: 1,
  institutionSafeMode: true,
  ai_providers: {},
  host_ai_operations: {},
  data_sources: {
    ms365: {
      allowed: true,
      auth_mode: 'delegated_only',
      operations: {
        read_mail: 'allow',
        create_draft: 'allow',
        update_draft: 'allow',
        move_to_ordinary_folder: 'allow',
        read_calendar: 'allow',
        write_calendar: 'allow_with_log',
        read_task: 'allow',
        write_task: 'allow',
        send_mail: 'deny',
        forward_mail: 'deny',
        reply_send_mail: 'deny',
        delete_mail: 'deny',
        permanent_delete: 'deny',
        move_to_deleted_items: 'deny',
        move_to_junk: 'deny',
        move_to_recoverable_items: 'deny',
        read_shared_mailbox: 'deny',
        read_chat: 'deny',
        read_files: 'deny',
        write_files: 'deny',
      },
    },
  },
  channels: {},
};

describe('m365-operations', () => {
  afterEach(() => {
    _setAccessPermissionsForTesting(null);
  });

  describe('classifyGraphPath', () => {
    const cases: Array<[string, string, M365Operation]> = [
      ['GET', '/v1.0/me/messages/abc', 'read_mail'],
      ['GET', '/v1.0/me/messages?$top=10', 'read_mail'],
      ['GET', '/v1.0/me/mailFolders/Inbox/messages', 'read_mail'],
      ['POST', '/v1.0/me/messages', 'create_draft'],
      ['PATCH', '/v1.0/me/messages/abc', 'update_draft'],
      ['POST', '/v1.0/me/messages/abc/createReply', 'create_draft'],
      ['POST', '/v1.0/me/messages/abc/createForward', 'create_draft'],
      ['POST', '/v1.0/me/sendMail', 'send_mail'],
      ['POST', '/v1.0/me/messages/abc/send', 'send_mail'],
      ['POST', '/v1.0/me/messages/abc/forward', 'forward_mail'],
      ['POST', '/v1.0/me/messages/abc/reply', 'reply_send_mail'],
      ['POST', '/v1.0/me/messages/abc/replyAll', 'reply_send_mail'],
      ['POST', '/v1.0/me/messages/abc/move', 'move_unknown_destination'],
      ['DELETE', '/v1.0/me/messages/abc', 'delete_mail'],
      ['POST', '/v1.0/me/messages/abc/permanentDelete', 'permanent_delete'],
      ['GET', '/v1.0/me/calendar/events', 'read_calendar'],
      ['POST', '/v1.0/me/events', 'write_calendar'],
      ['DELETE', '/v1.0/me/events/abc', 'write_calendar'],
      ['GET', '/v1.0/me/todo/lists', 'read_task'],
      ['POST', '/v1.0/me/todo/lists/abc/tasks', 'write_task'],
      ['PATCH', '/v1.0/me/todo/lists/abc/tasks/xyz', 'write_task'],
      ['GET', '/v1.0/users/abc/messages', 'tenant_directory_read'],
      ['GET', '/v1.0/groups/abc/messages', 'tenant_directory_read'],
      ['GET', '/v1.0/me/chats', 'read_chat'],
      ['GET', '/v1.0/me/joinedTeams', 'read_chat'],
      ['GET', '/v1.0/me/drive/items/abc', 'read_files'],
      ['POST', '/v1.0/me/drive/items', 'write_files'],
      ['GET', '/v1.0/me/onenote/notebooks', 'read_files'],
      ['GET', '/v1.0/me/wingdings', 'unknown'],
    ];
    for (const [method, path, expected] of cases) {
      it(`${method} ${path} → ${expected}`, () => {
        expect(classifyGraphPath(method, path)).toBe(expected);
      });
    }
  });

  describe('classifyDestinationFolder', () => {
    it('matches well-known names case-insensitively', () => {
      expect(classifyDestinationFolder('deletedItems')).toBe(
        'move_to_deleted_items',
      );
      expect(classifyDestinationFolder('Deleted Items')).toBe(
        'move_to_deleted_items',
      );
      expect(classifyDestinationFolder('junkemail')).toBe('move_to_junk');
      expect(classifyDestinationFolder('Junk Email')).toBe('move_to_junk');
      expect(classifyDestinationFolder('recoverableitems')).toBe(
        'move_to_recoverable_items',
      );
    });

    it('opaque Graph IDs become move_unknown_destination', () => {
      const id =
        'AAMkAGE3OTU3ODBkLTBlZmMtNGQzOC04NmEzLTAwY2IyN2YxYmY1ZQAuAAAAAAC66pewqf6QSKc1QHAeZmRGAQC64gW9-tuFQ75mQVGQwApHAAAAMSsrAAA=';
      expect(classifyDestinationFolder(id)).toBe('move_unknown_destination');
    });

    it('display names default to move_to_ordinary_folder', () => {
      expect(classifyDestinationFolder('Sorted/GC-Student')).toBe(
        'move_to_ordinary_folder',
      );
      expect(classifyDestinationFolder('Inbox')).toBe(
        'move_to_ordinary_folder',
      );
    });

    it('empty input is move_unknown_destination', () => {
      expect(classifyDestinationFolder('')).toBe('move_unknown_destination');
    });
  });

  describe('evaluateM365Operation', () => {
    it('allows read_mail under default ms365 entry', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('read_mail');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('ms365_read_mail_allow');
    });

    it('allow_with_log produces an allow decision', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('write_calendar');
      expect(d.allow).toBe(true);
      expect(d.reasonCode).toBe('ms365_write_calendar_allow_with_log');
    });

    it('denies send_mail', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('send_mail');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ms365_send_mail_denied');
    });

    it('denies move_to_deleted_items', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('move_to_deleted_items');
      expect(d.allow).toBe(false);
    });

    it('denies an operation absent from the operations table', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('move_unknown_destination');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ms365_operation_unknown');
    });

    it('denies tenant_directory_read', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      const d = evaluateM365Operation('tenant_directory_read');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ms365_operation_unknown');
    });

    it('denies all when ms365 entry is allowed=false', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        data_sources: {
          ms365: { ...STRICT_BASE.data_sources.ms365, allowed: false },
        },
      });
      const d = evaluateM365Operation('read_mail');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ms365_denied');
    });

    it('denies all when ms365 entry is missing', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        data_sources: {},
      });
      const d = evaluateM365Operation('read_mail');
      expect(d.allow).toBe(false);
      expect(d.reasonCode).toBe('ms365_not_in_registry');
    });
  });

  describe('enforceM365Operation', () => {
    it('throws PolicyDeniedError on deny in strict mode', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceM365Operation('send_mail')).toThrow(
        PolicyDeniedError,
      );
    });

    it('does not throw on allow', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() => enforceM365Operation('read_mail')).not.toThrow();
    });

    it('does not throw on deny in telemetry-only mode', () => {
      _setAccessPermissionsForTesting({
        ...STRICT_BASE,
        institutionSafeMode: false,
      });
      expect(() => enforceM365Operation('send_mail')).not.toThrow();
    });
  });

  describe('enforceM365Path', () => {
    it('classifies and enforces in one call', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() =>
        enforceM365Path('GET', '/v1.0/me/messages/abc'),
      ).not.toThrow();
      expect(() => enforceM365Path('POST', '/v1.0/me/sendMail')).toThrow(
        PolicyDeniedError,
      );
      expect(() => enforceM365Path('DELETE', '/v1.0/me/messages/abc')).toThrow(
        PolicyDeniedError,
      );
    });

    it('move with no destination context is denied (move_unknown_destination)', () => {
      _setAccessPermissionsForTesting(STRICT_BASE);
      expect(() =>
        enforceM365Path('POST', '/v1.0/me/messages/abc/move'),
      ).toThrow(PolicyDeniedError);
    });
  });
});
