import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every `pnpm …` a committed document tells somebody to run, exists.
 *
 * This is here because it already failed once. `pnpm drill` and `pnpm eval:live`
 * were dropped from `package.json` while splitting a milestone into commits: the
 * scripts they run were still in `scripts/`, three documents still told a reader
 * to run them, and nothing noticed — `pnpm check` stayed green for a day.
 *
 * Nothing could have noticed, which is the point. knip treats `scripts/*.mjs` as
 * entry points, so it cannot report one as unreferenced; the shell only finds out
 * when a person types the command; and a README is prose to every other tool in
 * this repository. A document that tells somebody to run something is a promise,
 * and this is the only thing that holds it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * pnpm's own verbs. `pnpm audit` is both — a built-in and a script here — and
 * either reading of it is true, so it needs no special case.
 */
const BUILT_IN = new Set([
  'add',
  'audit',
  'create',
  'dlx',
  'exec',
  'import',
  'install',
  'link',
  'list',
  'outdated',
  'pack',
  'patch',
  'publish',
  'remove',
  'run',
  'setup',
  'store',
  'test',
  'unlink',
  'update',
  'why',
]);

interface Command {
  /** The script name, as a reader would type it. */
  readonly script: string;
  /** The workspace it belongs to: `null` for the root. */
  readonly workspace: string | null;
  readonly path: string;
  readonly line: number;
}

/**
 * `pnpm <script>` and `pnpm --filter <package> <script>`, and nothing else.
 *
 * A flag between the two (`pnpm -r --if-present dev`) is deliberately not
 * matched: that shape appears inside a script definition being explained, not as
 * an instruction to type, and matching it would make this test a parser of shell
 * rather than a reader of documentation.
 */
const CALL = /\bpnpm (?:--filter (?<workspace>@?[\w/-]+) )?(?<script>[a-z][\w:-]*)/gu;

function tracked(pattern: string): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', pattern], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => existsSync(join(ROOT, path)));
}

function commandsIn(path: string): readonly Command[] {
  const found: Command[] = [];

  readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(CALL)) {
        const script = match.groups?.['script'] ?? '';
        if (BUILT_IN.has(script)) continue;
        found.push({
          script,
          workspace: match.groups?.['workspace'] ?? null,
          path,
          line: index + 1,
        });
      }
    });

  return found;
}

function scriptsOf(workspace: string | null): Readonly<Record<string, string>> {
  const path = workspace === null ? 'package.json' : `${workspaceDir(workspace)}/package.json`;
  const parsed: { scripts?: Readonly<Record<string, string>> } = JSON.parse(
    readFileSync(join(ROOT, path), 'utf8'),
  );

  return parsed.scripts ?? {};
}

/** `@fca/api` is `apps/api`. Read from the manifest rather than assumed. */
function workspaceDir(name: string): string {
  for (const manifest of tracked('*/*/package.json')) {
    const parsed: { name?: string } = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8'));
    if (parsed.name === name) return dirname(manifest);
  }

  throw new Error(`no workspace is named ${name}`);
}

describe('the commands the documentation tells somebody to run', () => {
  // One pattern, every depth: a git pathspec is not a shell glob, and `*`
  // crosses `/` here — so `*.md` already reaches `apps/api/drizzle/notes/`.
  // Adding a pattern per level reads as thoroughness and only buys duplicates,
  // which then report the same missing command three times.
  const documented = tracked('*.md');
  const commands = documented.flatMap((path) => commandsIn(path));

  it('are found in more than a handful of places, or this is reading nothing', () => {
    expect(documented.length).toBeGreaterThan(5);
    expect(commands.length).toBeGreaterThan(20);
  });

  it('all exist', () => {
    // Reported with the file and line, because "a command in the docs does not
    // exist" is the least useful sentence this can produce.
    const missing = commands.filter(({ script, workspace }) => !(script in scriptsOf(workspace)));

    expect(missing).toEqual([]);
  });

  it('include the three that are documented but deliberately outside `pnpm check`', () => {
    // The ones that go missing quietly: nothing in the repository runs them, so
    // the only thing that would notice is a person following the README.
    const names = new Set(commands.map(({ script }) => script));

    expect(names).toContain('test:e2e');
    expect(names).toContain('eval:live');
    expect(names).toContain('drill');
  });
});
