import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuestOnly, Protected } from '../guards';

import { renderApp, signedIn, signedOut, stubApi } from '@/__tests__/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

function routes() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<p>the sign-in screen</p>} />
      </Route>
      <Route element={<Protected />}>
        <Route path="/" element={<p>the private screen</p>} />
      </Route>
    </Routes>
  );
}

describe('a protected route', () => {
  it('shows the screen to someone with a session', async () => {
    stubApi(() => signedIn());

    renderApp(routes(), '/');

    expect(await screen.findByText('the private screen')).toBeInTheDocument();
  });

  it('sends someone without one to sign in', async () => {
    stubApi(() => signedOut());

    renderApp(routes(), '/');

    expect(await screen.findByText('the sign-in screen')).toBeInTheDocument();
  });

  it('waits for the answer instead of guessing', () => {
    // Redirecting before `/auth/me` returns is what makes a signed-in person see
    // the sign-in screen flash on every page load.
    stubApi(() => new Promise<Response>(() => undefined));

    renderApp(routes(), '/');

    expect(screen.queryByText('the sign-in screen')).toBeNull();
    expect(screen.queryByText('the private screen')).toBeNull();
  });

  it('says so rather than redirecting when it cannot ask at all', async () => {
    // A network failure is not evidence that nobody is signed in, and treating
    // it as a sign-out would throw someone out because their wifi dropped.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    renderApp(routes(), '/');

    expect(await screen.findByRole('status')).toHaveTextContent('Cannot reach the server');
    expect(screen.queryByText('the sign-in screen')).toBeNull();
  });
});

describe('a guest-only route', () => {
  it('sends someone who is already signed in to the application', async () => {
    stubApi(() => signedIn());

    renderApp(routes(), '/login');

    expect(await screen.findByText('the private screen')).toBeInTheDocument();
  });

  it('shows the screen to someone who is not', async () => {
    stubApi(() => signedOut());

    renderApp(routes(), '/login');

    expect(await screen.findByText('the sign-in screen')).toBeInTheDocument();
  });
});
