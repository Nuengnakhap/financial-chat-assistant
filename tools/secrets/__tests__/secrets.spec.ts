import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Nothing committed here is a credential.
 *
 * A test rather than `gitleaks` in a pre-commit hook, for two reasons that both
 * come down to whether it actually runs. A hook needs a binary that is not in
 * this repository and is not installed by `pnpm install`, so on a fresh clone it
 * is a rule nobody is subject to; and a hook is skipped by `--no-verify`, which
 * is exactly what somebody in a hurry reaches for. This runs inside
 * `pnpm check`, which is the gate that already exists.
 *
 * **High-signal patterns only, deliberately.** No `password=` and no
 * `secret\\s*=`, because `.env.example` is full of both by design and a scanner
 * that has to be argued with is a scanner somebody switches off. What is left is
 * the set of shapes that are a credential or nothing: a key with a vendor
 * prefix, a private key block, a signed token.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Shape {
  readonly name: string;
  readonly pattern: RegExp;
}

const SECRETS: readonly Shape[] = [
  { name: 'an OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/u },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/u },
  { name: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/u },
  { name: 'a private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u },
  // Three base64url segments, which is a signed token and not much else.
  {
    name: 'a signed token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  },
];

/** Not source: a lockfile is hashes, and a snapshot is generated. */
const NOT_SOURCE = /pnpm-lock[.]yaml$|[.](png|svg|ico|woff2?)$|__snapshots__\//u;

/**
 * Tracked **and** present. A file staged for deletion is still in `git
 * ls-files`, and reading it would end this suite with an `ENOENT` that names
 * the scanner rather than the deletion — a scan that crashes on an ordinary
 * `git rm` is a scan somebody removes from the gate.
 */
function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '' && !NOT_SOURCE.test(path))
    .filter((path) => existsSync(join(ROOT, path)));
}

interface Finding {
  readonly path: string;
  readonly shape: string;
  readonly line: number;
}

function scan(paths: readonly string[]): readonly Finding[] {
  const found: Finding[] = [];

  for (const path of paths) {
    const lines = readFileSync(join(ROOT, path), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const shape of SECRETS) {
        if (shape.pattern.test(line)) found.push({ path, shape: shape.name, line: index + 1 });
      }
    });
  }

  return found;
}

describe('what is committed', () => {
  const tracked = trackedFiles();

  it('is more than a handful of files, or this is scanning nothing', () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  it('holds no credential in any shape that is a credential or nothing', () => {
    // Reported with the path and the line, because "a secret is in the repo" is
    // the least useful sentence a scanner can produce.
    expect(scan(tracked)).toEqual([]);
  });

  it('finds one when there is one, so a green run means something', () => {
    // The scanner proving itself. Without this, a pattern that stopped matching
    // — a typo in a character class, a rule that never compiled — would read
    // exactly like a clean repository.
    //
    // Assembled from pieces rather than written out, so this file does not trip
    // the scan that reads every tracked file including this one. Excluding it
    // instead would leave one file in the repository a secret could sit in.
    const planted = [
      ['sk', '-proj-', 'abcdefghij', '0123456789', 'KLMNOPQRST'],
      ['AKIA', 'ABCDEFGHIJKLMNOP'],
      ['-----BEGIN ', 'OPENSSH', ' PRIVATE ', 'KEY', '-----'],
      ['eyJ', 'abcdefghijk', '.eyJ', 'abcdefghijk', '.', 'abcdefghijklm'],
    ].map((pieces) => pieces.join(''));

    for (const secret of planted) {
      expect(SECRETS.some((shape) => shape.pattern.test(secret))).toBe(true);
    }
  });

  it('reads this very file, and finds nothing in it', () => {
    // The other half of the case above: the samples are assembled at runtime,
    // so a scan of this file has to come back empty. If it does not, the pieces
    // above have been written out somewhere and the self-test has become a
    // reason to exclude a file from the scan.
    expect(scan([join('tools', 'secrets', '__tests__', 'secrets.spec.ts')])).toEqual([]);
  });

  it('does not shout about the placeholders that are supposed to be there', () => {
    // `.env.example` exists to be copied, so it is full of the words a naive
    // scanner keys on. A rule that flagged it would be switched off in a week.
    expect(scan(['.env.example'])).toEqual([]);
  });
});
