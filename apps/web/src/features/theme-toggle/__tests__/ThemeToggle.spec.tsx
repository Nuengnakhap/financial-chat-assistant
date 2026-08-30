import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '../../../shared/theme/theme';
import { ThemeToggle } from '../ThemeToggle';

afterEach(() => {
  delete document.documentElement.dataset['theme'];
  window.localStorage.clear();
});

describe('ThemeToggle', () => {
  it('names the theme it will switch to, not the one showing', async () => {
    render(<ThemeToggle />);

    // "Switch to dark" is an instruction; "Dark" alone is a state nobody can
    // read from an icon.
    const button = screen.getByRole('button', { name: 'Switch to dark theme' });
    await userEvent.click(button);

    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('marks the document and remembers the choice', async () => {
    render(<ThemeToggle />);

    await userEvent.click(screen.getByRole('button'));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('switches back, clearing both', async () => {
    render(<ThemeToggle />);

    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByRole('button'));

    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('starts from what the document already says, not from light', () => {
    // The inline script runs before React. If this read storage instead, a
    // person who chose dark would see the toggle offering to switch to dark.
    document.documentElement.dataset['theme'] = 'dark';

    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });
});
