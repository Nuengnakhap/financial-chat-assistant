import type { DomainEvent } from '@fca/domain';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from './database.service';
import { outboxEvents } from './schema';
import type { TxContext, UnitOfWork } from './unit-of-work';
import { DrizzleConversationRepository } from '../../conversation/infrastructure/drizzle-conversation.repository';
import { DrizzleMessageRepository } from '../../conversation/infrastructure/drizzle-message.repository';

@Injectable()
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(work: (ctx: TxContext) => Promise<T>): Promise<T> {
    return await this.database.db.transaction(
      async (tx) => {
        const pending: DomainEvent[] = [];
        const result = await work({
          conversations: new DrizzleConversationRepository(tx),
          messages: new DrizzleMessageRepository(tx),
          publish: (event) => pending.push(event),
        });

        // Written last but in the same transaction: if the work throws, the
        // events go with it, and nothing is ever told about a change that was
        // rolled back.
        if (pending.length > 0) {
          await tx.insert(outboxEvents).values(
            pending.map((event) => ({
              aggregate: event.aggregate,
              aggregateId: event.aggregateId,
              type: event.type,
              payload: event.payload,
            })),
          );
        }
        return result;
      },
      // Explicit rather than inherited from a server default nobody reads.
      // Transactions here are short by rule: no LLM call, no external I/O.
      { isolationLevel: 'read committed' },
    );
  }
}
