import { loginBody, registerBody } from '@fca/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignInForm } from '../components/SignInForm';

import { renderApp, refused, signedIn, stubApi } from '@/__tests__/harness';
import { HINT } from '@/config/form';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(email: string, password: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('signing in', () => {
  it('sends the credentials when they satisfy the contract', async () => {
    const { calls } = stubApi(() => signedIn());

    renderApp(<SignInForm />);
    await fill('ada@example.com', 'correct-horse-battery');

    expect(calls).toContain('POST /api/v1/auth/login');
  });

  it('does not spend a request on a password the contract already refuses', async () => {
    // The same schema the server validates with. Asking it first means a form
    // cannot disagree with the endpoint about what is acceptable.
    const { calls } = stubApi(() => signedIn());

    renderApp(<SignInForm />);
    await fill('ada@example.com', 'short');

    expect(calls).toEqual([]);
    expect(screen.getByText(HINT.password)).toBeInTheDocument();
  });

  it('shows the wording the server chose, not one of its own', async () => {
    stubApi(() =>
      refused({ code: 'unauthenticated', message: 'Email or password is incorrect.', status: 401 }),
    );

    renderApp(<SignInForm />);
    await fill('ada@example.com', 'correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('counts down and refuses to submit while rate limited', async () => {
    stubApi(() =>
      refused({
        code: 'rate_limited',
        message: 'Too many attempts.',
        status: 429,
        headers: { 'retry-after': '45' },
      }),
    );

    renderApp(<SignInForm />);
    await fill('ada@example.com', 'correct-horse-battery');

    const button = await screen.findByRole('button', { name: /Try again in 45s/ });
    expect(button).toBeDisabled();
  });
});

describe('the wording and the rules it describes', () => {
  it('quotes a password length the schema actually enforces', () => {
    // The sentence lives in the form and the rule lives in the contract, so a
    // changed rule has to break something rather than quietly outlive its hint.
    const tooShort = loginBody.safeParse({ email: 'a@b.co', password: 'x'.repeat(11) });
    const longEnough = loginBody.safeParse({ email: 'a@b.co', password: 'x'.repeat(12) });

    expect(HINT.password).toContain('12');
    expect(tooShort.success).toBe(false);
    expect(longEnough.success).toBe(true);
  });

  it('describes the same rule registration uses', () => {
    const short = registerBody.safeParse({
      displayName: 'Ada',
      email: 'a@b.co',
      password: 'x'.repeat(11),
    });

    expect(short.success).toBe(false);
  });
});
