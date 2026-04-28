/**
 * MS365 / Microsoft Graph operation gate.
 *
 * The granted Graph scope (typically `Mail.ReadWrite`) technically permits
 * deletion, destructive folder moves, etc. The operation table in
 * `config/access-permissions.defaults.json` (data_sources.ms365.operations)
 * narrows that surface to the reviewed personal-productivity workflow:
 * read mail, create/update drafts, move to ordinary folder, calendar +
 * tasks read/write — yes; delete, send, move-to-trash/junk/recoverable,
 * shared mailbox, app-only, /users/{id}, files, chats — no.
 *
 * Two entry points:
 *   classifyGraphPath(method, url) — for unambiguous URL+method patterns.
 *     Returns an M365Operation. Move operations and other body-dependent
 *     classifications return 'move_unknown_destination' rather than
 *     guessing — the caller should pass an explicit operation in those
 *     cases via enforceM365Operation directly.
 *   enforceM365Operation(op, ctx?) — direct enforcement when the caller
 *     knows the operation. Strict mode throws PolicyDeniedError; telemetry
 *     mode logs and returns.
 *
 * See docs/INSTITUTION_SAFE_MODE.md and docs/FUTURE_FEATURE_REVIEW.md for
 * the policy posture this module enforces.
 */
import { logger } from '../logger.js';
import { getConfig } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import type { PolicyDecision } from './types.js';

export type M365Operation =
  | 'read_mail'
  | 'create_draft'
  | 'update_draft'
  | 'move_to_ordinary_folder'
  | 'move_to_deleted_items'
  | 'move_to_junk'
  | 'move_to_recoverable_items'
  | 'move_unknown_destination'
  | 'send_mail'
  | 'forward_mail'
  | 'reply_send_mail'
  | 'delete_mail'
  | 'permanent_delete'
  | 'read_calendar'
  | 'write_calendar'
  | 'read_task'
  | 'write_task'
  | 'read_shared_mailbox'
  | 'read_chat'
  | 'read_files'
  | 'write_files'
  | 'tenant_directory_read'
  | 'unknown';

export interface M365OperationContext {
  graphPath?: string;
  destinationFolder?: string;
}

/** Folder names (well-known or display) that are destructive destinations. */
const DESTRUCTIVE_FOLDER_PATTERNS = {
  deleted_items: /^(deletedItems|deleted\s*items)$/i,
  junk: /^(junkemail|junk\s*email|junk)$/i,
  recoverable:
    /^(recoverableitems(deletions|purges|versions)?|recoverable\s*items)$/i,
};

/** Classify a destination folder name (well-known or display) into a move
 *  operation. Returns move_unknown_destination if the name is opaque
 *  (e.g., a raw Graph folder ID like AAMkAGE3...). */
export function classifyDestinationFolder(name: string): M365Operation {
  if (!name) return 'move_unknown_destination';
  if (DESTRUCTIVE_FOLDER_PATTERNS.deleted_items.test(name))
    return 'move_to_deleted_items';
  if (DESTRUCTIVE_FOLDER_PATTERNS.junk.test(name)) return 'move_to_junk';
  if (DESTRUCTIVE_FOLDER_PATTERNS.recoverable.test(name))
    return 'move_to_recoverable_items';
  // Looks like a Graph folder ID (long base64-ish) — opaque
  if (/^[A-Za-z0-9_=+/-]{40,}$/.test(name)) return 'move_unknown_destination';
  return 'move_to_ordinary_folder';
}

/**
 * Map (method, url) onto an M365Operation. Returns 'unknown' for paths the
 * classifier doesn't recognize — strict-mode policy then refuses to act on
 * unknown operations rather than silently allowing them.
 *
 * Move operations (POST /me/messages/{id}/move) require body inspection
 * (destinationId is in the body, not the URL); the classifier returns
 * 'move_unknown_destination' and the caller must use enforceM365Operation
 * with the resolved destination context.
 */
export function classifyGraphPath(method: string, url: string): M365Operation {
  const m = method.toUpperCase();
  // Strip query string; we classify on the path only.
  const pathOnly = url.replace(/\?.*$/, '');

  // Tenant-wide / user-targeted reads always denied
  if (/\/v1\.0\/users\/[^/]+/.test(pathOnly)) return 'tenant_directory_read';
  if (/\/v1\.0\/groups\/[^/]+/.test(pathOnly)) return 'tenant_directory_read';

  // Chats and Teams
  if (/\/me\/chats(\/|$)/.test(pathOnly)) return 'read_chat';
  if (/\/me\/joinedTeams(\/|$)/.test(pathOnly)) return 'read_chat';

  // Files
  if (/\/me\/drive(\/|$)/.test(pathOnly)) {
    return m === 'GET' ? 'read_files' : 'write_files';
  }
  if (/\/me\/onenote(\/|$)/.test(pathOnly)) return 'read_files';

  // Mail send / forward / reply
  if (m === 'POST' && /\/me\/sendMail$/.test(pathOnly)) return 'send_mail';
  if (m === 'POST' && /\/me\/messages\/[^/]+\/send$/.test(pathOnly))
    return 'send_mail';
  if (m === 'POST' && /\/me\/messages\/[^/]+\/forward$/.test(pathOnly))
    return 'forward_mail';
  if (m === 'POST' && /\/me\/messages\/[^/]+\/(reply|replyAll)$/.test(pathOnly))
    return 'reply_send_mail';

  // Move (destination in body — caller should provide context)
  if (m === 'POST' && /\/me\/messages\/[^/]+\/move$/.test(pathOnly))
    return 'move_unknown_destination';

  // Drafts and replies that produce drafts
  if (
    m === 'POST' &&
    /\/me\/messages\/[^/]+\/(createReply|createReplyAll|createForward)$/.test(
      pathOnly,
    )
  )
    return 'create_draft';
  if (m === 'PATCH' && /\/me\/messages\/[^/]+$/.test(pathOnly))
    return 'update_draft';
  if (m === 'POST' && /\/me\/messages$/.test(pathOnly)) return 'create_draft';

  // Delete
  if (m === 'DELETE' && /\/me\/messages\/[^/]+$/.test(pathOnly))
    return 'delete_mail';
  if (m === 'POST' && /\/me\/messages\/[^/]+\/permanentDelete$/.test(pathOnly))
    return 'permanent_delete';

  // Mail reads
  if (m === 'GET' && /\/me\/messages(\/|$)/.test(pathOnly)) return 'read_mail';
  if (m === 'GET' && /\/me\/mailFolders(\/|$)/.test(pathOnly))
    return 'read_mail';

  // Calendar
  if (m === 'GET' && /\/me\/(calendar|events|calendars)(\/|$)/.test(pathOnly))
    return 'read_calendar';
  if (
    (m === 'POST' || m === 'PATCH' || m === 'DELETE') &&
    /\/me\/(events|calendars)(\/|$)/.test(pathOnly)
  )
    return 'write_calendar';

  // Tasks (To Do)
  if (m === 'GET' && /\/me\/todo(\/|$)/.test(pathOnly)) return 'read_task';
  if (
    (m === 'POST' || m === 'PATCH' || m === 'DELETE') &&
    /\/me\/todo(\/|$)/.test(pathOnly)
  )
    return 'write_task';

  return 'unknown';
}

/** Look up the operation in data_sources.ms365.operations and return a
 *  PolicyDecision. */
export function evaluateM365Operation(
  operation: M365Operation,
  ctx: M365OperationContext = {},
): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const ms365 = cfg.data_sources.ms365;

  if (!ms365) {
    return {
      allow: false,
      reasonCode: 'ms365_not_in_registry',
      message:
        'data_sources.ms365 entry missing from access-permissions config',
      enforced,
      context: { operation, ...ctx },
    };
  }

  if (!ms365.allowed) {
    return {
      allow: false,
      reasonCode: 'ms365_denied',
      message: `MS365 data source denied: ${ms365.rationale ?? 'no rationale'}`,
      enforced,
      context: { operation, ...ctx },
    };
  }

  const operations = ms365.operations ?? {};
  const verdict = operations[operation];

  if (verdict === 'allow' || verdict === 'allow_with_log') {
    if (verdict === 'allow_with_log') {
      logger.info(
        {
          operation,
          graphPath: ctx.graphPath,
          destinationFolder: ctx.destinationFolder,
        },
        `m365-policy: ${operation} (logged)`,
      );
    }
    return {
      allow: true,
      reasonCode: `ms365_${operation}_${verdict}`,
      message: `MS365 ${operation} ${verdict}`,
      enforced,
      context: { operation, ...ctx },
    };
  }

  if (verdict === 'deny') {
    return {
      allow: false,
      reasonCode: `ms365_${operation}_denied`,
      message: `MS365 operation '${operation}' denied by access-permissions policy`,
      enforced,
      context: { operation, ...ctx },
    };
  }

  // Operation not in the table: treat as unknown / deny by default.
  return {
    allow: false,
    reasonCode: 'ms365_operation_unknown',
    message: `MS365 operation '${operation}' is not in the operations table — implicit deny`,
    enforced,
    context: { operation, ...ctx },
  };
}

/** Enforce an MS365 operation. In strict mode, throws PolicyDeniedError
 *  on deny. In telemetry-only mode, logs and returns. */
export function enforceM365Operation(
  operation: M365Operation,
  ctx: M365OperationContext = {},
): void {
  const decision = evaluateM365Operation(operation, ctx);
  if (decision.allow) return;
  if (decision.enforced) {
    logger.warn(
      {
        reasonCode: decision.reasonCode,
        operation,
        graphPath: ctx.graphPath,
        destinationFolder: ctx.destinationFolder,
      },
      `m365-policy: ${decision.message}`,
    );
    throw new PolicyDeniedError(decision);
  }
  logger.warn(
    {
      reasonCode: decision.reasonCode,
      operation,
      graphPath: ctx.graphPath,
      destinationFolder: ctx.destinationFolder,
    },
    `m365-policy: would have denied (telemetry-only): ${decision.message}`,
  );
}

/** Combined helper: classify the URL and enforce in one call. Use this
 *  when the URL+method is sufficient to determine the operation. For
 *  body-dependent operations (moves), call enforceM365Operation directly
 *  with the resolved destination context. */
export function enforceM365Path(
  method: string,
  url: string,
  ctx: M365OperationContext = {},
): void {
  const operation = classifyGraphPath(method, url);
  enforceM365Operation(operation, { ...ctx, graphPath: url });
}
