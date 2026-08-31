import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, currentTheme, rememberTheme, THEME_STORAGE_KEY } from '../theme';

afterEach(() => {
  delete document.documentElement.dataset['theme'];
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('the theme in the document', () => {
  it('is light when nothing has been chosen', () => {
    expect(currentTheme()).toBe('light');
  });

  it('marks the document for dark and unmarks it for light', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(currentTheme()).toBe('dark');

    applyTheme('light');
    // Removed rather than set to "light": the stylesheet's default is light, so
    // an attribute would be a second source of truth for the same thing.
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(currentTheme()).toBe('light');
  });
});

describe('remembering the choice', () => {
  it('stores it under the shared key', () => {
    rememberTheme('dark');

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('carries on when storage refuses the write', () => {
    // Private windows in some browsers throw here. Losing the preference is
    // survivable; throwing during a click is not.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => {
      rememberTheme('dark');
    }).not.toThrow();
  });
});

describe('the inline script in index.html', () => {
  it('reads the same key this module writes', () => {
    // It cannot import, so the key is a literal there. If the two drift, everyone
    // who chose dark silently gets light on the next load and nothing fails.
    const html = readFileSync(join(import.meta.dirname, '..', '..', '..', 'index.html'), 'utf8');

    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  it('only ever sets dark, because light needs no attribute', () => {
    const html = readFileSync(join(import.meta.dirname, '..', '..', '..', 'index.html'), 'utf8');

    expect(html).toContain("dataset.theme = 'dark'");
    expect(html).not.toContain("dataset.theme = 'light'");
  });
});
