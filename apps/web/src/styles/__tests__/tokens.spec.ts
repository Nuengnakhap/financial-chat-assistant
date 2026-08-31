import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * Every scale in `tokens.css` is closed with `*: initial`, so an off-scale class
 * such as `p-5` compiles to nothing at all. That is the right outcome and the
 * wrong failure: nothing is reported, the padding is simply absent, and it is
 * found by looking at the screen.
 *
 * This turns that silence into a failing test naming the file and the class.
 */

const WEB_ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(WEB_ROOT, 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');

function walk(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(SRC);

/** Every single-quoted string inside a fragment of source. */
function quotedIn(fragment: string): readonly string[] {
  return [...fragment.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

/**
 * Class names live in a `className` attribute, in an expression assigned to one,
 * or in a quoted argument to `cx`. All three reach the DOM alike, so all three
 * are checked — a ternary used to be the way around every fence at once.
 *
 * Comments are stripped first: prose inside a `cx(...)` call is not a class, and
 * counting it would fill this report with English words.
 */
function classesIn(source: string): readonly string[] {
  const withoutComments = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const literals = [...withoutComments.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? '');
  const expressions = [...withoutComments.matchAll(/className=\{([^}]*)\}/g)].flatMap((m) =>
    quotedIn(m[1] ?? ''),
  );
  const calls = [...withoutComments.matchAll(/\bcx\(([\s\S]*?)\)/g)].flatMap((m) =>
    quotedIn(m[1] ?? ''),
  );

  return [...literals, ...expressions, ...calls]
    .flatMap((value) => value.split(/\s+/))
    .map((value) => value.trim())
    .filter((value) => /^[a-z][a-z0-9:_/.-]*$/i.test(value));
}

const used = new Map<string, string>();
for (const file of files) {
  if (!/\.tsx?$/.test(file)) continue;
  for (const candidate of classesIn(readFileSync(file, 'utf8'))) {
    if (!used.has(candidate)) used.set(candidate, relative(WEB_ROOT, file));
  }
}

const require_ = createRequire(import.meta.url);
const tailwindCss = require_.resolve('tailwindcss/index.css');

async function compileAll(candidates: readonly string[]): Promise<string> {
  // The font imports resolve through Vite, not through this loader, and they
  // contribute no utilities.
  const source = readFileSync(TOKENS, 'utf8').replace(/@import '@fontsource[^']*';\n/g, '');
  const compiler = await compile(source, {
    base: dirname(TOKENS),
    loadStylesheet: (_id, base) =>
      Promise.resolve({ path: tailwindCss, base, content: readFileSync(tailwindCss, 'utf8') }),
  });
  return compiler.build([...candidates]);
}

const escape = (candidate: string): string => candidate.replace(/[.:/[\]()%#!]/g, (m) => `\\${m}`);

describe('the stylesheet', () => {
  it('is the only one in the application', () => {
    // Every custom rule someone adds elsewhere is a second place to look when a
    // colour is wrong. There is one.
    const stylesheets = files
      .filter((file) => file.endsWith('.css'))
      .map((f) => relative(WEB_ROOT, f));

    expect(stylesheets).toEqual(['src/styles/tokens.css']);
  });

  it('closes every scale it owns', () => {
    const source = readFileSync(TOKENS, 'utf8');

    const scales = [
      '--color-*',
      '--spacing-*',
      '--radius-*',
      '--text-*',
      '--font-weight-*',
      '--tracking-*',
      '--container-*',
      '--shadow-*',
    ];

    for (const scale of scales) {
      expect(source, `${scale} is not reset, so Tailwind's own scale is still reachable`).toContain(
        `${scale}: initial;`,
      );
    }
  });
});

describe('finding the classes to check', () => {
  it('sees one written as an expression rather than a literal', () => {
    // The hole this closed: a ternary reaches the DOM exactly as a literal does,
    // and used to reach it without passing any of the three fences.
    const source = "<p className={busy ? 'text-muted' : 'text-text'} />";

    expect(classesIn(source)).toEqual(expect.arrayContaining(['text-muted', 'text-text']));
  });

  it('does not mistake prose in a comment for a class', () => {
    // Otherwise every English word inside a `cx(...)` explanation is reported as
    // an off-scale utility, and the report becomes unreadable.
    expect(classesIn('// className="not a class name"\n')).toEqual([]);
  });
});

describe('every class the application uses', () => {
  it('found classes to check', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it('compiles to a rule', async () => {
    const candidates = [...used.keys()];
    const css = await compileAll(candidates);

    const missing = candidates
      .filter((candidate) => !css.includes(`.${escape(candidate)}`))
      .map((candidate) => `${candidate}  (${used.get(candidate) ?? '?'})`);

    expect(missing, 'these produce no CSS — they are off the scale in tokens.css').toEqual([]);
  });

  it('would notice a class that is off the scale', async () => {
    // Proving the check can fail: p-3 exists, p-5 was never declared.
    const css = await compileAll(['p-3', 'p-5']);

    expect(css).toContain('.p-3');
    expect(css).not.toContain('.p-5');
  });
});
