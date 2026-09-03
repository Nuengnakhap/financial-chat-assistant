import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOMAIN_EVENT_TYPES } from '@fca/domain';

/**
 * A name nobody publishes is a name somebody will publish wrongly.
 *
 * Five of these went two milestones with no publisher, kept alive by a `CHECK`
 * constraint that listed them and a type that admitted them — so the vocabulary
 * described a system that did not exist, and the only thing that noticed was an
 * audit. This is what notices next time.
 *
 * It reads the source rather than the running system on purpose: a test that
 * stood up the app and watched for events would only prove that the paths it
 * happened to exercise still fire, which is a weaker statement in a more
 * expensive test.
 */

const API = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/api/src');

/** Where a name would be defined rather than used, so finding it there proves nothing. */
const VOCABULARY = /events[.]ts$|schema[.]ts$|domain-events[.]ts$/u;

/**
 * Comments and block comments taken out, so a name mentioned in prose does not
 * read as a publisher. Five of these names lived for two milestones inside a
 * `CHECK` constraint and a type; a check that a comment can satisfy would let
 * the sixth do the same.
 */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ').replaceAll(/\/\/[^\n]*/gu, ' ');
}

function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') yield* sourceFiles(path);
      continue;
    }
    if (path.endsWith('.ts') && !path.endsWith('.spec.ts') && !VOCABULARY.test(path)) yield path;
  }
}

const production = [...sourceFiles(API)].map((path) => code(readFileSync(path, 'utf8'))).join('\n');

describe('the domain event vocabulary', () => {
  it('has something in it, or this file is asserting nothing', () => {
    expect(DOMAIN_EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it('does not accept a name that only a comment mentions', () => {
    // The check the version before this one would have passed. `usage.recorded`
    // is named in a comment in `events.ts` explaining why it was removed, and a
    // substring search over raw source would have found it there.
    expect(code("// keeps 'usage.recorded' for the record\nconst x = 1;")).not.toContain(
      "'usage.recorded'",
    );
    expect(code("/* 'usage.recorded' */ const y = 2;")).not.toContain("'usage.recorded'");
    expect(code("publish('usage.recorded');")).toContain("'usage.recorded'");
  });

  it.each(DOMAIN_EVENT_TYPES)('%s is published by something', (type) => {
    // Outside `events.ts`, `schema.ts` and the queue's own contract, all three
    // of which list every name by definition — and outside comments, because a
    // name explained in prose is not a name anybody publishes.
    expect(production).toContain(`'${type}'`);
  });
});
