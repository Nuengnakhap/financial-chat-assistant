import { ConversationId } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import type { PublishedEvent } from '../../../shared/persistence/outbox-relay';
import type { PurgeConversationUseCase } from '../../application/use-cases/purge-conversation.use-case';
import { ConversationDeletionSubscriber } from '../conversation-deletion.subscriber';

const logger = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));
const ID = ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21');

const eventFor = (aggregateId: string): PublishedEvent => ({
  id: '42',
  aggregate: 'conversation',
  aggregateId,
  type: 'conversation.delete_requested',
  payload: {},
});

const subscriberWith = (execute = vi.fn()) => ({
  subscriber: new ConversationDeletionSubscriber(
    { execute } as unknown as PurgeConversationUseCase,
    logger,
  ),
  execute,
});

describe('the far end of the delete pipeline', () => {
  it('purges the conversation the event names', async () => {
    const { subscriber, execute } = subscriberWith(vi.fn().mockResolvedValue(true));

    await subscriber.handle(eventFor(ID));

    expect(execute).toHaveBeenCalledWith(ID);
  });

  it('says it consumes exactly the event the delete request writes', async () => {
    // The two halves are joined by this string and nothing else, so it is worth
    // an assertion rather than a reading.
    expect(subscriberWith().subscriber.handles).toBe('conversation.delete_requested');
    await Promise.resolve();
  });

  it('finishes quietly when the conversation was already gone', async () => {
    // A job delivered twice. Throwing would turn the redelivery that the outbox
    // exists to guarantee into a job that can never complete.
    const { subscriber } = subscriberWith(vi.fn().mockResolvedValue(false));

    await expect(subscriber.handle(eventFor(ID))).resolves.toBe(undefined);
  });

  it('does not retry an id that cannot name a conversation', async () => {
    const { subscriber, execute } = subscriberWith();

    await expect(subscriber.handle(eventFor('not-a-uuid'))).resolves.toBe(undefined);

    // Nothing to do and nothing a retry would fix — five attempts and a
    // permanent failure would report a broken broker instead of a bad event.
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a database failure through, because that is what a retry is for', async () => {
    const { subscriber } = subscriberWith(vi.fn().mockRejectedValue(new Error('connection lost')));

    await expect(subscriber.handle(eventFor(ID))).rejects.toThrow('connection lost');
  });
});
