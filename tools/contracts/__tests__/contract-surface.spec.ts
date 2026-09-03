import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classify, type Change } from '../classify';
import { buildSurface, serialiseSurface, type ContractSurface } from '../surface';

/**
 * The gate. What this package publishes is recorded in a file next to it, and
 * this fails when the two disagree — saying, per field, how much thought the
 * difference needs.
 *
 * It fails on **any** difference rather than passing quietly on a safe one.
 * A check that lets an additive change through leaves the recorded surface
 * describing something that stopped being true, and the next reviewer compares
 * against that. The value here is the classification in the message, not a
 * green tick; re-recording is one command.
 *
 *   pnpm contracts:snapshot                        # additive or ordering
 *   CONTRACTS_ALLOW_BREAKING=1 pnpm contracts:snapshot   # and you meant it
 */

const SNAPSHOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/contracts/__snapshots__/surface.json',
);

const WRITING = process.env['CONTRACTS_SNAPSHOT'] === 'write';
const BREAKING_ALLOWED = process.env['CONTRACTS_ALLOW_BREAKING'] === '1';

function record(surface: ContractSurface): void {
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, serialiseSurface(surface), 'utf8');
}

const read = (): string => readFileSync(SNAPSHOT, 'utf8');

function recorded(): ContractSurface | null {
  try {
    const parsed: unknown = JSON.parse(read());

    return parsed as ContractSurface;
  } catch {
    return null;
  }
}

const line = (change: Change): string => `  [${change.verdict}] ${change.path} — ${change.detail}`;

function report(changes: readonly Change[]): string {
  const of = (verdict: Change['verdict']): readonly Change[] =>
    changes.filter((change) => change.verdict === verdict);

  return [
    'The published contract differs from the recorded surface.',
    '',
    ...of('breaking').map(line),
    ...of('deploy-ordered').map(line),
    ...of('additive').map(line),
    '',
    of('breaking').length > 0
      ? 'A breaking change needs a deprecation or a v2 — see "Changing a contract" in CONTRIBUTING.md. If it is deliberate: CONTRACTS_ALLOW_BREAKING=1 pnpm contracts:snapshot'
      : 'Safe. Re-record with `pnpm contracts:snapshot` and commit the file.',
    of('deploy-ordered').length > 0
      ? 'Deploy the server before the client: an older server would not send these.'
      : '',
  ].join('\n');
}

describe('the published contract surface', () => {
  const current = buildSurface();
  const before = recorded();
  const changes = before === null ? [] : classify(before, current);
  const breaking = changes.filter((change) => change.verdict === 'breaking');

  it('is recorded in a file that is committed beside it', () => {
    // Nothing to compare against on the very first run, and nothing to lose:
    // whatever the contract is today becomes the baseline the next change moves.
    if (before === null) {
      record(current);
      expect.fail(`No recorded surface. Wrote one to ${SNAPSHOT} — read it and commit it.`);
    }

    if (breaking.length > 0 && !BREAKING_ALLOWED) {
      // Deliberately before the write: `pnpm contracts:snapshot` on its own
      // must not be able to record the removal of a field nobody meant to lose.
      expect.fail(report(changes));
    }

    if (WRITING) {
      record(current);
      return;
    }

    if (changes.length > 0) expect.fail(report(changes));
    // Byte for byte, not "parses to the same thing". The file is generated, so
    // anything that rewrites it — a formatter, an editor adding a newline —
    // makes it stop being what the tool would write, and the next person to run
    // `pnpm contracts:snapshot` gets a diff they did not cause.
    expect(read()).toBe(serialiseSurface(current));
  });

  it('carries every schema the package exports, and knows which way each travels', () => {
    const schemas = Object.entries(current).filter(([, entry]) => entry.kind === 'schema');
    const requests = schemas.filter(
      ([, entry]) => entry.kind === 'schema' && entry.role === 'request',
    );

    // A surface with no requests in it would classify every added required
    // field as an ordering note, which is the one verdict that is never red.
    expect(schemas.length).toBeGreaterThan(20);
    expect(requests.map(([path]) => path)).toContain('authContract.login.body');
    expect(current['authContract.login.path']).toEqual({
      kind: 'value',
      value: '/api/v1/auth/login',
    });
    expect(current['parseStreamEvent']).toEqual({ kind: 'function' });
  });

  it('cannot see a rule that JSON Schema has no way to say', () => {
    // `messageView` refines: a verification report is present exactly when an
    // assistant message is complete. JSON Schema cannot express that, so
    // `z.toJSONSchema` drops it and this gate is blind to it. The invariant is
    // held by the type, by `message.spec.ts` and by a CHECK constraint —
    // written down here so nobody reads a green snapshot as proof of it.
    const view = current['messageView'];

    expect(view?.kind).toBe('schema');
    expect(JSON.stringify(view)).not.toContain('verification report is present');
  });
});
