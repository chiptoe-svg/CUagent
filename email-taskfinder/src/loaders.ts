import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { CONFIG_DIR } from './config.js';
import {
  Classification,
  EmailAccount,
  Taxonomy,
} from './types.js';

function loadYamlFile<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = YAML.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function loadAccounts(): EmailAccount[] {
  const data = loadYamlFile<{ accounts?: EmailAccount[] }>(
    path.join(CONFIG_DIR, 'accounts.yaml'),
    {},
  );
  return (data.accounts || []).filter((a) => a.enabled !== false);
}

export function loadClassification(): Classification {
  const data = loadYamlFile<Partial<Classification>>(
    path.join(CONFIG_DIR, 'classification.yaml'),
    {},
  );
  return {
    action_templates: Array.isArray(data.action_templates)
      ? data.action_templates
      : [],
    skip_senders: Array.isArray(data.skip_senders) ? data.skip_senders : [],
    overrides: Array.isArray(data.overrides) ? data.overrides : [],
  };
}

export function loadInstitutions(): Set<string> {
  const data = loadYamlFile<{ institutions?: string[] }>(
    path.join(CONFIG_DIR, 'institutions.yaml'),
    {},
  );
  return new Set(
    (data.institutions || []).map((s) => String(s).toLowerCase().trim()),
  );
}

export function loadKnownContacts(): Set<string> {
  const data = loadYamlFile<{ known_contacts?: string[] }>(
    path.join(CONFIG_DIR, 'known_contacts.yaml'),
    {},
  );
  return new Set(
    (data.known_contacts || []).map((s) => String(s).toLowerCase().trim()),
  );
}

export function loadTaxonomy(): Taxonomy {
  const data = loadYamlFile<{
    taxonomy?: string[];
    taxonomy_context?: Record<string, string>;
  }>(path.join(CONFIG_DIR, 'taxonomy.yaml'), {});
  return {
    folders: data.taxonomy || [],
    context: data.taxonomy_context || {},
  };
}
