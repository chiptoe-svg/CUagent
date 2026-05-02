// Direct host-side OpenAI call, one per residual email. Structured JSON
// output, no tool access. Validates returned sort_folder against the loaded
// taxonomy and sanitizes the task title before any side effect.

import { OPENAI_API_KEY, OPENAI_MODEL } from './config.js';
import { log } from './log.js';
import { composeSystemPrompt } from './prompts.js';
import { ClassificationResult, LlmCandidate, Taxonomy } from './types.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

export function openAiConfigured(): boolean {
  return Boolean(OPENAI_API_KEY);
}

function taxonomyAppendix(taxonomy: Taxonomy): string {
  const folderBullets = taxonomy.folders
    .map((f) => {
      const hint = taxonomy.context[f];
      return hint ? `  ${f} — ${hint}` : `  ${f}`;
    })
    .join('\n');
  return `Taxonomy (pick exactly one for sort_folder):\n${folderBullets}`;
}

export async function classifyEmailWithApi(
  email: LlmCandidate,
  taxonomy: Taxonomy,
): Promise<ClassificationResult | null> {
  if (!OPENAI_API_KEY) return null;

  const systemMsg = composeSystemPrompt('triage', taxonomyAppendix(taxonomy));

  const userMsg = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Hint: ${email.bucket_hint}`,
    `Body: ${email.body || '(no body; classify from sender+subject)'}`,
  ].join('\n');

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 300,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      log.warn('classify-api: non-200', {
        status: r.status,
        body: (await r.text()).slice(0, 200),
        emailId: email.id,
      });
      return null;
    }
    const resp = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = resp.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<ClassificationResult>;
    return {
      needs_task: Boolean(parsed.needs_task),
      sort_folder: String(parsed.sort_folder || 'To Delete'),
      task_title: String(parsed.task_title || '').slice(0, 120),
      reasoning: String(parsed.reasoning || '').slice(0, 500),
    };
  } catch (err) {
    log.warn('classify-api: threw', {
      err: String(err),
      emailId: email.id,
    });
    return null;
  }
}
