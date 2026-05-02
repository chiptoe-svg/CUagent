export type Account = 'gmail' | 'outlook';

export interface EmailMinimal {
  id: string;
  account: Account;
  from: string;
  subject: string;
  conversationId?: string;
  receivedIso?: string;
}

export interface LlmCandidate extends EmailMinimal {
  bucket_hint: 'solicited' | 'outreach_check';
  body?: string;
}

export interface ActionTemplate {
  name: string;
  match: {
    from_address?: string;
    from_domain?: string;
    subject_contains?: string[];
  };
  create_task?: {
    title: string;
    folder: string;
    due_offset_days?: number;
  };
  skip?: boolean;
}

export interface SkipSender {
  from_address?: string;
  from_domain?: string;
  folder: string;
}

export interface Override {
  email_id: string;
  decision: 'task' | 'skip' | 'label-only';
  sort_folder?: string;
  reasoning?: string;
}

export interface Classification {
  action_templates: ActionTemplate[];
  skip_senders: SkipSender[];
  overrides: Override[];
}

export interface Taxonomy {
  folders: string[];
  context: Record<string, string>;
}

export interface EmailAccount {
  id: string;
  type: 'gws' | 'ms365';
  address?: string;
  enabled?: boolean;
}

export interface Progress {
  last_scan_date?: { gmail?: string; outlook?: string };
  last_scan_run_id?: string;
}

export interface PendingResidual {
  scan_run_id: string;
  email_id: string;
  account: Account;
  from: string;
  subject: string;
  handoff_ts: string;
  first_handoff_ts: string;
  attempt_count: number;
}

export interface ScanOutcome {
  scan_run_id: string;
  scanned: number;
  template_tasks: number;
  template_skips: number;
  skip_sender_count: number;
  llm_candidates: LlmCandidate[];
  errors: string[];
}

export interface ClassificationResult {
  needs_task: boolean;
  sort_folder: string;
  task_title: string;
  reasoning: string;
}
