export type Theme = 'light' | 'dark';

/**
 * Also written as a literal in the inline script in `index.html`, which has to
 * run before React mounts. `__tests__/theme.spec.ts` asserts the two agree, so
 * renaming this cannot silently strand everyone who chose dark.
 */
export const THEME_STORAGE_KEY = 'fca-theme';

/**
 * Two values, not three. A "system" option reads as a third state the person has
 * to reason about — "what is it right now?" — and the answer changes under them
 * when the operating system decides it is evening.
 */
export function currentTheme(): Theme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.dataset['theme'] = 'dark';
  } else {
    delete document.documentElement.dataset['theme'];
  }
}

/**
 * Storage is unavailable in a private window in some browsers and throws on
 * write. A theme that cannot be remembered is worth less than a page that
 * cannot render.
 */
export function rememberTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignored on purpose: the theme still applies for this page.
  }
}
