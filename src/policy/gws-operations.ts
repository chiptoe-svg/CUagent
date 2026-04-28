/**
 * Google Workspace operation gate.
 *
 * Looks up operations in `data_sources.gws.operations` from the
 * access-permissions config. Operation table covers mail (read,
 * draft create/update, no send/delete/forward), calendar (read,
 * write_with_log), tasks (read, write), Docs/Sheets/Slides
 * (read/create/update, no delete), and Drive (list, read-with-log,
 * no general write/share/permissions).
 *
 * Current code wires this only at the two existing call sites
 * (gmail listGmail and fetchGmailBody, both read_mail). Forward-
 * looking operations are still in the registry so future code is
 * gated automatically.
 */
import { logger } from '../logger.js';
import { getConfig } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import type { PolicyDecision } from './types.js';

export type GwsOperation =
  // Mail
  | 'read_mail'
  | 'create_draft'
  | 'update_draft'
  | 'send_mail'
  | 'forward_mail'
  | 'reply_send_mail'
  | 'delete_mail'
  | 'permanent_delete'
  | 'move_to_trash'
  | 'move_to_spam'
  | 'move_to_ordinary_label'
  // Calendar
  | 'read_calendar'
  | 'write_calendar'
  // Tasks
  | 'read_task'
  | 'write_task'
  // Docs / Sheets / Slides
  | 'docs_read'
  | 'docs_create'
  | 'docs_update'
  | 'docs_delete'
  | 'sheets_read'
  | 'sheets_create'
  | 'sheets_update'
  | 'sheets_delete'
  | 'slides_read'
  | 'slides_create'
  | 'slides_update'
  | 'slides_delete'
  // Drive
  | 'drive_list'
  | 'drive_read_file'
  | 'drive_write_file'
  | 'drive_share'
  | 'drive_make_public'
  | 'drive_change_permissions'
  // Catch-all
  | 'unknown';

export interface GwsOperationContext {
  command?: string;
  product?: string;
}

export function evaluateGwsOperation(
  operation: GwsOperation,
  ctx: GwsOperationContext = {},
): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const gws = cfg.data_sources.gws;

  if (!gws) {
    return {
      allow: false,
      reasonCode: 'gws_not_in_registry',
      message: 'data_sources.gws entry missing from access-permissions config',
      enforced,
      context: { operation, ...ctx },
    };
  }

  if (!gws.allowed) {
    return {
      allow: false,
      reasonCode: 'gws_denied',
      message: `GWS data source denied: ${gws.rationale ?? 'no rationale'}`,
      enforced,
      context: { operation, ...ctx },
    };
  }

  const operations = gws.operations ?? {};
  const verdict = operations[operation];

  if (verdict === 'allow' || verdict === 'allow_with_log') {
    if (verdict === 'allow_with_log') {
      logger.info(
        { operation, command: ctx.command, product: ctx.product },
        `gws-policy: ${operation} (logged)`,
      );
    }
    return {
      allow: true,
      reasonCode: `gws_${operation}_${verdict}`,
      message: `GWS ${operation} ${verdict}`,
      enforced,
      context: { operation, ...ctx },
    };
  }

  // Special semantics: drive_write_file maps to deny_unless_doc_sheet_slide
  // — we treat it as deny here; callers who actually want to write a
  // Doc/Sheet/Slide file should use the docs_*/sheets_*/slides_*
  // operations directly, which have their own allow entries.
  if (verdict === 'deny' || verdict === 'deny_unless_doc_sheet_slide') {
    return {
      allow: false,
      reasonCode: `gws_${operation}_denied`,
      message: `GWS operation '${operation}' denied by access-permissions policy`,
      enforced,
      context: { operation, verdict, ...ctx },
    };
  }

  return {
    allow: false,
    reasonCode: 'gws_operation_unknown',
    message: `GWS operation '${operation}' is not in the operations table — implicit deny`,
    enforced,
    context: { operation, ...ctx },
  };
}

export function enforceGwsOperation(
  operation: GwsOperation,
  ctx: GwsOperationContext = {},
): void {
  const decision = evaluateGwsOperation(operation, ctx);
  if (decision.allow) return;
  if (decision.enforced) {
    logger.warn(
      {
        reasonCode: decision.reasonCode,
        operation,
        command: ctx.command,
        product: ctx.product,
      },
      `gws-policy: ${decision.message}`,
    );
    throw new PolicyDeniedError(decision);
  }
  logger.warn(
    {
      reasonCode: decision.reasonCode,
      operation,
      command: ctx.command,
      product: ctx.product,
    },
    `gws-policy: would have denied (telemetry-only): ${decision.message}`,
  );
}
