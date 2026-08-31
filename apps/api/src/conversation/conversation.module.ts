import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { AppendUserMessageUseCase } from './application/use-cases/append-user-message.use-case';
import { CreateConversationUseCase } from './application/use-cases/create-conversation.use-case';
import { DescribeConversationUseCase } from './application/use-cases/describe-conversation.use-case';
import { ListConversationsUseCase } from './application/use-cases/list-conversations.use-case';
import { ListMessagesUseCase } from './application/use-cases/list-messages.use-case';
import { PurgeConversationUseCase } from './application/use-cases/purge-conversation.use-case';
import { RemoveConversationUseCase } from './application/use-cases/remove-conversation.use-case';
import { ConversationDeletionSubscriber } from './infrastructure/conversation-deletion.subscriber';
import { ConversationController } from './presentation/conversation.controller';
import { ConversationsController } from './presentation/conversations.controller';
import { SessionGuard } from '../shared/http/session.guard';
import { PersistenceModule } from '../shared/persistence/persistence.module';

/**
 * `IdentityModule` is imported for one thing: `SessionGuard` is built in the
 * injector of the module whose controllers use it, and the token issuer it
 * verifies with is bound over there. Nothing else crosses — the two contexts
 * share the database through `UnitOfWork` and say nothing else to each other.
 */
@Module({
  imports: [PersistenceModule, IdentityModule],
  controllers: [ConversationsController, ConversationController],
  providers: [
    ListConversationsUseCase,
    ListMessagesUseCase,
    AppendUserMessageUseCase,
    CreateConversationUseCase,
    DescribeConversationUseCase,
    RemoveConversationUseCase,
    PurgeConversationUseCase,
    ConversationDeletionSubscriber,
    SessionGuard,
  ],
  // The composition root builds the handler list; this is the one this context
  // contributes to it.
  // `AppendUserMessageUseCase` leaves for the generation context, which is what
  // calls it: writing the message is where sending one begins.
  exports: [ConversationDeletionSubscriber, AppendUserMessageUseCase],
})
export class ConversationModule {}
