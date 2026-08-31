import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { applyTheme, currentTheme, rememberTheme, type Theme } from '@/lib/theme';

const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'light' };

export function ThemeToggle() {
  // Seeded from the document rather than from storage: the inline script in
  // index.html has already decided, and reading it twice invites the two
  // answers to differ.
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next = NEXT[theme];

  const switchTheme = (): void => {
    applyTheme(next);
    rememberTheme(next);
    setTheme(next);
  };

  return (
    <Button variant="ghost" size="sm" aria-label={`Switch to ${next} theme`} onClick={switchTheme}>
      {theme === 'dark' ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </Button>
  );
}
