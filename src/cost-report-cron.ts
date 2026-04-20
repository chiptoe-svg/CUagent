/**
 * Daily cost-report auto-fire.
 *
 * Computes next fire time from a cron expression (default 21:00 local),
 * setTimeout's to it, fires, then re-arms. No external cron daemon. The
 * report itself is pure host-side work (DB query + pricing lookup), so
 * it costs nothing and can't be knocked out by a model misbehaving.
 *
 * Self-disables if no main group is registered at fire time — useful
 * during initial setup before /chatid has been run.
 */
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { buildCostReport, formatCostReport } from './cost-report.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface DailyCostReportDeps {
  cronExpr: string;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export function startDailyCostReport(deps: DailyCostReportDeps): void {
  const schedule = () => {
    let nextMs: number;
    try {
      const interval = CronExpressionParser.parse(deps.cronExpr, {
        tz: TIMEZONE,
      });
      nextMs = interval.next().getTime() - Date.now();
    } catch (err) {
      logger.warn(
        { cronExpr: deps.cronExpr, err },
        'Invalid cost-report cron expr — disabling daily report',
      );
      return;
    }
    // Clamp to sane bounds (node timers choke on huge values) just in case.
    nextMs = Math.max(1_000, Math.min(nextMs, 25 * 60 * 60 * 1000));
    logger.info(
      {
        cronExpr: deps.cronExpr,
        nextInMs: nextMs,
        nextAt: new Date(Date.now() + nextMs).toISOString(),
      },
      'Daily cost report armed',
    );
    setTimeout(async () => {
      try {
        const groups = deps.registeredGroups();
        const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
        if (!mainEntry) {
          logger.warn('Daily cost report: no main group registered — skipping');
        } else {
          const [mainJid] = mainEntry;
          const report = buildCostReport(24);
          const text = formatCostReport(report, 24);
          await deps.sendMessage(mainJid, text);
          logger.info(
            {
              totalUsd: report.totalUsd.toFixed(4),
              runCount: report.runCount,
            },
            'Daily cost report sent',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Daily cost report fire failed');
      }
      schedule(); // re-arm for next day
    }, nextMs);
  };

  schedule();
}
