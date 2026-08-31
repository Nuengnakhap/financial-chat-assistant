import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, refused, renderApp, signedIn, stubApi } from '@/__tests__/harness';
import { HINT } from '@/config/form';
import { RegisterPage } from '@/pages/RegisterPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(name: string, email: string, password: string): Promise<void> {
  if (name !== '') await userEvent.type(screen.getByLabelText('Name'), name);
  if (email !== '') await userEvent.type(screen.getByLabelText('Email'), email);
  if (password !== '') await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('registering', () => {
  it('creates the account when the fields satisfy the contract', async () => {
    const { calls } = stubApi(() => json({ user: signedIn() }, 201));

    renderApp(<RegisterPage />);
    await fill('Ada Lovelace', 'ada@example.com', 'correct-horse-battery');

    expect(calls).toContain('POST /api/v1/auth/register');
  });

  it('turns down a name nobody filled in before spending a request', async () => {
    const { calls } = stubApi(() => json({ user: signedIn() }, 201));

    renderApp(<RegisterPage />);
    await fill('', 'ada@example.com', 'correct-horse-battery');

    expect(calls).toEqual([]);
    expect(screen.getByText(HINT.displayName)).toBeInTheDocument();
  });

  it('shows what the server said when the address is refused', async () => {
    stubApi(() =>
      refused({ code: 'conflict', message: 'That address cannot be used.', status: 409 }),
    );

    renderApp(<RegisterPage />);
    await fill('Ada Lovelace', 'ada@example.com', 'correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent('That address cannot be used.');
  });

  it('offers the way back to signing in', () => {
    stubApi(() => json({ user: signedIn() }, 201));

    renderApp(<RegisterPage />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});
