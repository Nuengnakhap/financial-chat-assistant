import type { AppConfig } from '@fca/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../database.service';
import { messages } from '../schema';
import { insertConversation, insertUser, startHarness, type Harness } from './harness';

let h: Harness;
let service: DatabaseService;

beforeAll(async () => {
  h = await startHarness();
  const url = process.env['TEST_DATABASE_URL'] ?? '';
  service = new DatabaseService({ database: { url } } as AppConfig);
});
afterAll(async () => {
  await service.onModuleDestroy();
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

describe('the database as a readiness dependency', () => {
  it('answers when it is reachable', async () => {
    await expect(service.check()).resolves.toBeUndefined();
  });

  it('names itself, so a failing probe says which dependency it was', () => {
    expect(service.name).toBe('postgres');
  });

  it('reports unreachable rather than hanging', async () => {
    const unreachable = new DatabaseService({
      database: { url: 'postgresql://nobody:nothing@127.0.0.1:1/none' },
    } as AppConfig);

    await expect(unreachable.check()).rejects.toThrow();
    await unreachable.onModuleDestroy();
  });
});

describe('reading a row back', () => {
  it('returns money as a bigint, never as a float', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values({
      conversationId,
      role: 'assistant',
      parts: [],
      status: 'stopped',
      seq: 1,
      costMicroUsd: 9_007_199_254_740_993n,
    });

    const [row] = await h.db.select().from(messages);

    // Beyond Number.MAX_SAFE_INTEGER: a number column would round this.
    expect(row?.costMicroUsd).toBe(9_007_199_254_740_993n);
  });
});
