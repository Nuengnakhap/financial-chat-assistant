import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';

import { GuestOnly, Protected } from './guards';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { forgetSession } from '@/domains/auth';
import { onSessionExpired } from '@/lib/api/session-expiry';
import { ChatPage } from '@/pages/ChatPage';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { SessionsPage } from '@/pages/SessionsPage';

/**
 * A refused refresh ends the session wherever the person happens to be — the
 * third way one ends, alongside signing out and revoking the session you are
 * holding, and all three have to leave the same nothing behind. The cache is
 * emptied before the redirect so the guards agree with it rather than racing it.
 */
function SessionExpiry() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onSessionExpired(() => {
        forgetSession(queryClient);
        void navigate('/login', { replace: true });
      }),
    [navigate, queryClient],
  );

  return null;
}

/**
 * Every screen and the rules for reaching them. Separate from `Router` because
 * that one chooses a history, and a test wanting to start on `/login` should not
 * have to fake the browser's address bar to do it.
 */
export function AppScreens() {
  return (
    <>
      <SessionExpiry />
      <ErrorBoundary label="The page">
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>
          <Route element={<Protected />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/c/:id" element={<ChatPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </>
  );
}

export function Router() {
  return (
    <BrowserRouter>
      <AppScreens />
    </BrowserRouter>
  );
}
