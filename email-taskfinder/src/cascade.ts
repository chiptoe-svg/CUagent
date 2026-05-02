// Bucket cascade matchers: action_templates (bucket 1), skip_senders (bucket 2),
// and the bucket-3 hint (institutions / known contacts). Plus title sanitization
// and taxonomy validation for any LLM-returned values.

import { log } from './log.js';
import {
  ActionTemplate,
  EmailMinimal,
  LlmCandidate,
  SkipSender,
  Taxonomy,
} from './types.js';

function senderMatches(
  from: string,
  matchAddress?: string,
  matchDomain?: string,
): boolean {
  const f = from.toLowerCase();
  if (matchAddress && f.includes(matchAddress.toLowerCase())) return true;
  if (matchDomain) {
    const at = f.lastIndexOf('@');
    if (at >= 0) {
      const domain = f.slice(at + 1).replace(/[>\s].*$/, '');
      if (domain.endsWith(matchDomain.toLowerCase())) return true;
    }
  }
  return false;
}

export function matchActionTemplate(
  email: EmailMinimal,
  templates: ActionTemplate[],
): ActionTemplate | null {
  const subjectLower = (email.subject || '').toLowerCase();
  for (const t of templates) {
    const senderHit = senderMatches(
      email.from,
      t.match.from_address,
      t.match.from_domain,
    );
    if (!senderHit) continue;
    const needles = t.match.subject_contains || [];
    if (needles.length === 0) return t;
    for (const needle of needles) {
      if (subjectLower.includes(String(needle).toLowerCase())) return t;
    }
  }
  return null;
}

export function matchSkipSender(
  email: EmailMinimal,
  rules: SkipSender[],
): SkipSender | null {
  for (const r of rules) {
    if (senderMatches(email.from, r.from_address, r.from_domain)) return r;
  }
  return null;
}

export function bucketHintFor(
  email: EmailMinimal,
  institutions: Set<string>,
  contacts: Set<string>,
): LlmCandidate['bucket_hint'] {
  const from = email.from.toLowerCase();
  const bareAddr = from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/)?.[0] || from;
  if (contacts.has(bareAddr)) return 'solicited';
  const at = bareAddr.lastIndexOf('@');
  if (at >= 0) {
    const domain = bareAddr.slice(at + 1);
    if (institutions.has(domain)) return 'solicited';
    const parts = domain.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (institutions.has(parts.slice(i).join('.'))) return 'solicited';
    }
  }
  return 'outreach_check';
}

export function substituteTitle(template: string, email: EmailMinimal): string {
  return template.replace(/\{subject\}/g, email.subject);
}

export function buildCleanTitle(
  raw: string,
  account: 'gmail' | 'outlook',
  folder: string,
): string {
  return `${raw} → /${account}/${folder}`;
}

export function validateSortFolder(
  returned: string,
  taxonomy: Taxonomy,
): string {
  if (taxonomy.folders.length === 0) return returned;
  if (taxonomy.folders.includes(returned)) return returned;
  log.warn('sort_folder not in taxonomy — defaulting', {
    returned,
    validCount: taxonomy.folders.length,
  });
  return taxonomy.folders.includes('To Delete')
    ? 'To Delete'
    : taxonomy.folders[0];
}

export function sanitizeTaskTitle(raw: string, sourceSubject: string): string {
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  const scare =
    /^(URGENT|ACTION REQUIRED|IMPORTANT|ATTN|FINAL NOTICE)[:\s]\s*/i;
  if (scare.test(t) && !scare.test(sourceSubject || '')) {
    t = t.replace(scare, '').trim();
  }
  return t.slice(0, 120);
}
