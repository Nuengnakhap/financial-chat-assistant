import { describe, expect, it } from 'vitest';

import { InvalidTransitionError } from '../../errors';
import { isErr, isOk } from '../../result';
import {
  MESSAGE_STATUSES,
  canTransitionMessage,
  isTerminalMessageStatus,
  transitionMessage,
  type MessageStatus,
} from '../message-status.machine';

const TERMINAL: readonly MessageStatus[] = ['complete', 'stopped', 'error'];

describe('the allowed edges', () => {
  it.each(TERMINAL)('lets a generating message finish as %s', (status) => {
    const result = transitionMessage('generating', status);
    expect(isOk(result) && result.value).toBe(status);
  });
});

describe('the forbidden edges', () => {
  it.each(TERMINAL)('refuses to reopen a %s message', (status) => {
    for (const target of MESSAGE_STATUSES) {
      expect(canTransitionMessage(status, target)).toBe(false);
    }
  });

  it('refuses to move a message to the state it is already in', () => {
    expect(canTransitionMessage('generating', 'generating')).toBe(false);
  });

  it('reports the attempted edge without leaking anything else', () => {
    const result = transitionMessage('complete', 'stopped');

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(InvalidTransitionError);
    expect(result.error.message).toBe('Message cannot move from complete to stopped.');
    expect(result.error.details).toEqual({ from: 'complete', to: 'stopped' });
  });
});

describe('the shape of the lifecycle', () => {
  it('has exactly one non-terminal status', () => {
    const open = MESSAGE_STATUSES.filter((status) => !isTerminalMessageStatus(status));
    expect(open).toEqual(['generating']);
  });

  it('lists every status the transition table knows about', () => {
    // Drift between the list, the union and ALLOWED is a compile error. What the
    // types cannot express, and this checks, is that no status self-loops.
    for (const status of MESSAGE_STATUSES) {
      expect(canTransitionMessage(status, status)).toBe(false);
    }
    expect(MESSAGE_STATUSES).toHaveLength(4);
  });

  it('reaches every terminal status from generating, so none is unreachable', () => {
    const reachable = MESSAGE_STATUSES.filter((status) =>
      canTransitionMessage('generating', status),
    );
    expect(new Set(reachable)).toEqual(new Set(TERMINAL));
  });
});
