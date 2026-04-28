/**
 * Channel + data source activation gates.
 *
 * Top-level allow/deny check against the corresponding entry in
 * config/access-permissions.{defaults,local}.json:
 *
 *   evaluateChannel(name)       → checks `channels.<name>.allowed`
 *   evaluateDataSource(id)      → checks `data_sources.<id>.allowed`
 *
 * These are coarser than the operation-level gates in m365-operations and
 * gws-operations: they decide whether the channel or data source is
 * permitted to register/activate at all. A denied entry means the
 * channel never connects (channels) or the provider is filtered out of
 * loadProviders() (data sources). The operation-level gates apply once
 * the data source is active.
 */
import { logger } from '../logger.js';
import { getConfig } from './access-permissions.js';
import { PolicyDeniedError } from './errors.js';
import type { PolicyDecision } from './types.js';

export function evaluateChannel(channelName: string): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const entry = cfg.channels[channelName];

  if (!entry) {
    return {
      allow: false,
      reasonCode: 'unknown_channel',
      message: `Channel '${channelName}' is not in access-permissions registry`,
      enforced,
      context: { channelName },
    };
  }

  if (!entry.allowed) {
    return {
      allow: false,
      reasonCode: 'channel_denied',
      message: `Channel '${channelName}' is denied: ${entry.rationale ?? 'no rationale provided'}`,
      enforced,
      context: { channelName, rationale: entry.rationale },
    };
  }

  return {
    allow: true,
    reasonCode: 'channel_allowed',
    message: `Channel '${channelName}' allowed${entry.mode ? ` (${entry.mode})` : ''}`,
    enforced,
    context: { channelName, mode: entry.mode },
  };
}

export function enforceChannel(channelName: string): void {
  const decision = evaluateChannel(channelName);
  if (decision.allow) return;
  if (decision.enforced) {
    logger.warn(
      { reasonCode: decision.reasonCode, channelName },
      `channel-policy: ${decision.message}`,
    );
    throw new PolicyDeniedError(decision);
  }
  logger.warn(
    { reasonCode: decision.reasonCode, channelName },
    `channel-policy: would have denied (telemetry-only): ${decision.message}`,
  );
}

export function evaluateDataSource(sourceId: string): PolicyDecision {
  const cfg = getConfig();
  const enforced = cfg.institutionSafeMode;
  const entry = cfg.data_sources[sourceId];

  if (!entry) {
    return {
      allow: false,
      reasonCode: 'unknown_data_source',
      message: `Data source '${sourceId}' is not in access-permissions registry`,
      enforced,
      context: { sourceId },
    };
  }

  if (!entry.allowed) {
    return {
      allow: false,
      reasonCode: 'data_source_denied',
      message: `Data source '${sourceId}' is denied: ${entry.rationale ?? 'no rationale provided'}`,
      enforced,
      context: { sourceId, rationale: entry.rationale },
    };
  }

  return {
    allow: true,
    reasonCode: 'data_source_allowed',
    message: `Data source '${sourceId}' allowed`,
    enforced,
    context: { sourceId },
  };
}

export function enforceDataSource(sourceId: string): void {
  const decision = evaluateDataSource(sourceId);
  if (decision.allow) return;
  if (decision.enforced) {
    logger.warn(
      { reasonCode: decision.reasonCode, sourceId },
      `data-source-policy: ${decision.message}`,
    );
    throw new PolicyDeniedError(decision);
  }
  logger.warn(
    { reasonCode: decision.reasonCode, sourceId },
    `data-source-policy: would have denied (telemetry-only): ${decision.message}`,
  );
}
