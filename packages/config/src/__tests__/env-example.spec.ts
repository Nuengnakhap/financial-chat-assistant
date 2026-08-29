import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_KEYS, envSchema } from '../env.schema';
import { loadConfig } from '../load';

/**
 * `.env.example` is the only instruction a new machine gets, so it is treated as
 * part of this package's contract rather than as documentation. These fail the
 * moment the file and the schema disagree, in either direction.
 */

function findUp(fileName: string): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, fileName);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`${fileName} not found above ${process.cwd()}`);
}

function parseDotenv(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return entries;
}

const example = parseDotenv(readFileSync(findUp('.env.example'), 'utf8'));

describe('.env.example', () => {
  it('documents only variables the schema knows', () => {
    // An orphan line is worse than a missing one: it looks authoritative and
    // silently does nothing.
    expect(Object.keys(example).filter((key) => !ENV_KEYS.includes(key))).toEqual([]);
  });

  it('documents every variable that has no default', () => {
    const empty = envSchema.safeParse({});
    const required = empty.success ? [] : empty.error.issues.map((issue) => String(issue.path[0]));

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((key) => !(key in example))).toEqual([]);
  });

  it('boots after the one step the file asks for, filling in the API key', () => {
    const config = loadConfig({ ...example, OPENAI_API_KEY: 'sk-placeholder' });

    expect(config.app.port).toBe(3000);
    expect(config.usage.limitUsd).toBe(1);
    expect(config.database.financialUrl).toContain('llm_reader');
  });

  it('leaves OPENAI_API_KEY blank, so a copied file fails loudly instead of at the provider', () => {
    expect(example['OPENAI_API_KEY']).toBe('');
    expect(() => loadConfig(example)).toThrow(/OPENAI_API_KEY/);
  });

  it('points every URL at the local docker stack', () => {
    expect(example['DATABASE_URL']).toContain('localhost:5432');
    expect(example['REDIS_URL']).toContain('localhost:6379');
  });
});
