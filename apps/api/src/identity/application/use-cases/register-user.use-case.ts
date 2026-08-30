import { ConflictError, Err, Ok, type RateLimitedError, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { CredentialPolicy } from '../credential-policy';
import type { StoredUser } from '../ports/user.repository';
import { SessionIssuer, type IssuedSession } from '../session-issuer';

export interface RegisterCommand {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly device: string;
  readonly ipHash: string;
}

export interface AuthResult {
  readonly user: StoredUser;
  readonly session: IssuedSession;
}

type RegisterError = ConflictError | RateLimitedError;

@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly credentials: CredentialPolicy,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(command: RegisterCommand): Promise<Result<AuthResult, RegisterError>> {
    // Counted first, and for two reasons: this endpoint says out loud whether an
    // address is taken, and it is the only one that spends argon2 on a request
    // nobody has authenticated.
    const allowed = await this.credentials.beginRegistration(command.ipHash);
    if (!allowed.ok) return allowed;

    // Hashed before the transaction opens: argon2 is deliberately slow, and a
    // transaction held across 30ms of CPU is 30ms of a connection nobody else has.
    const passwordHash = await this.credentials.hash(command.password);

    return await this.uow.run(async (ctx) => {
      const user = await ctx.users.create({
        email: command.email.trim(),
        displayName: command.displayName.trim(),
        passwordHash,
      });

      // Saying an address is taken is a real disclosure, so it is bounded rather
      // than hidden: hiding it would leave the person with no idea what went
      // wrong, while the counter above keeps the answer from being cheap.
      if (user === null) return Err(new ConflictError('Email already registered.'));

      const session = await this.issuer.issue(ctx.sessions, {
        userId: user.id,
        device: command.device,
        ipHash: command.ipHash,
      });

      return Ok({ user, session });
    });
  }
}
