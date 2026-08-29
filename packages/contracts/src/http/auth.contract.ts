import { z } from 'zod';

import { isoDateTime, ok, uuid } from '../primitives';

export const userView = z.object({
  id: uuid,
  email: z.email(),
  displayName: z.string().min(1).max(80),
  createdAt: isoDateTime,
});

export const sessionView = z.object({
  id: uuid,
  device: z.string().max(200),
  ipHash: z.string().max(64),
  lastUsedAt: isoDateTime,
  current: z.boolean(),
});

const credentials = z.object({
  email: z.email().max(254),
  // Long enough to matter, capped so a megabyte of input cannot reach argon2.
  password: z.string().min(12).max(200),
});

export const registerBody = credentials.extend({ displayName: z.string().min(1).max(80) });
export const loginBody = credentials;
export const userResponse = z.object({ user: userView });

export const authContract = {
  register: {
    method: 'POST',
    path: '/api/v1/auth/register',
    status: 201,
    body: registerBody,
    response: userResponse,
  },
  login: {
    method: 'POST',
    path: '/api/v1/auth/login',
    status: 200,
    body: loginBody,
    response: userResponse,
  },
  refresh: {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    status: 200,
    body: z.object({}),
    response: ok,
  },
  logout: {
    method: 'POST',
    path: '/api/v1/auth/logout',
    status: 200,
    body: z.object({}),
    response: ok,
  },
  me: { method: 'GET', path: '/api/v1/auth/me', status: 200, response: userResponse },
  listSessions: {
    method: 'GET',
    path: '/api/v1/auth/sessions',
    status: 200,
    response: z.object({ sessions: z.array(sessionView) }),
  },
  revokeSession: { method: 'DELETE', path: '/api/v1/auth/sessions/:id', status: 200, response: ok },
} as const;

export type UserView = z.infer<typeof userView>;
export type SessionView = z.infer<typeof sessionView>;
export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
