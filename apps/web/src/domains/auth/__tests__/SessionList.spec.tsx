import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionList } from '../components/SessionList';

import { json, refused, renderApp, stubApi } from '@/__tests__/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

const THIS_DEVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  device: 'Chrome on macOS',
  ipHash: 'abcdef0123456789',
  lastUsedAt: new Date().toISOString(),
  current: true,
};

const OTHER_DEVICE = {
  id: '22222222-2222-4222-8222-222222222222',
  device: 'Safari on iPhone',
  ipHash: '9876543210fedcba',
  lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  current: false,
};

/** Answers the list, and whatever the test says to the revoke. */
function withSessions(revoke: () => Response = () => json({ ok: true })) {
  return stubApi((url, init) => {
    if (init?.method === 'DELETE') return revoke();
    return json({ sessions: [THIS_DEVICE, OTHER_DEVICE] });
  });
}

describe('the list of signed-in devices', () => {
  it('marks the one being read on', async () => {
    withSessions();

    renderApp(<SessionList />);

    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
  });

  it('shows only the first eight characters of the address hash', async () => {
    // Enough to tell two rows apart, not enough to follow anyone with.
    withSessions();

    renderApp(<SessionList />);

    expect(await screen.findByText(/abcdef01/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef0123456789/)).toBeNull();
  });

  it('says when each was last used', async () => {
    withSessions();

    renderApp(<SessionList />);

    expect(await screen.findByText(/3 hours ago/)).toBeInTheDocument();
  });

  it('offers to read the list again when it cannot be fetched', async () => {
    const { calls } = stubApi(() =>
      refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 }),
    );

    renderApp(<SessionList />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(1);
    });
  });
});

describe('revoking', () => {
  it('asks once before doing it', async () => {
    const { calls } = withSessions();

    renderApp(<SessionList />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Revoke' }))[1]!);

    // The click armed the row; nothing has been sent.
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    expect(screen.getByText('Revoke this device?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(calls).toContain(`DELETE /api/v1/auth/sessions/${OTHER_DEVICE.id}`);
    });
  });

  it('lets someone change their mind', async () => {
    const { calls } = withSessions();

    renderApp(<SessionList />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Revoke' }))[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('spells out what revoking the row you are on costs', async () => {
    // One verb down the column, but the consequence is not the same on every
    // row, so it is said where the decision is made.
    withSessions();

    renderApp(<SessionList />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]!);

    expect(screen.getByText('This signs you out here.')).toBeInTheDocument();
  });

  it('says so when the server refuses, and leaves the row alone', async () => {
    withSessions(() =>
      refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 }),
    );

    renderApp(<SessionList />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Revoke' }))[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
  });
});
