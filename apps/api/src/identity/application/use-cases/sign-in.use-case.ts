import { Ok, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { CredentialPolicy, type SignInError } from '../credential-policy';
import { SessionIssuer } from '../session-issuer';
import type { AuthResult } from './register-user.use-case';

export interface SignInCommand {
  readonly email: string;
  readonly password: string;
  readonly device: string;
  readonly ipHash: string;
}

@Injectable()
export class SignInUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly credentials: CredentialPolicy,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(command: SignInCommand): Promise<Result<AuthResult, SignInError>> {
    const allowed = await this.credentials.beginSignIn(command.email, command.ipHash);
    if (!allowed.ok) return allowed;

    // Read in its own transaction rather than the one that issues the session:
    // verifying a password costs about thirty milliseconds of CPU, and holding a
    // connection open across it is thirty milliseconds nobody else can use.
    const found = await this.uow.run(
      async (ctx) => await ctx.users.findCredentialsByEmail(command.email),
    );

    const verified = await this.credentials.verify(found, command);
    if (!verified.ok) return verified;

    const session = await this.uow.run(
      async (ctx) =>
        await this.issuer.issue(ctx.sessions, {
          userId: verified.value.id,
          device: command.device,
          ipHash: command.ipHash,
        }),
    );

    return Ok({ user: verified.value, session });
  }
}
