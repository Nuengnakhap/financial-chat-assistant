import { authContract, type LoginBody, type RegisterBody, type UserView } from '@fca/contracts';
import type { Result } from '@fca/domain';
import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { callerFrom } from './caller';
import { SessionCookies } from './session-cookies';
import { toUserView } from './user-view';
import { ZodPayload } from '../../shared/http/zod-payload.pipe';
import type { AuthResult } from '../application/use-cases/register-user.use-case';
import { RegisterUserUseCase } from '../application/use-cases/register-user.use-case';
import { SignInUseCase } from '../application/use-cases/sign-in.use-case';

const REGISTER = new ZodPayload(authContract.register.body);
const LOGIN = new ZodPayload(authContract.login.body);

/**
 * The two ways a session begins. Paths and shapes come from `@fca/contracts`,
 * so this cannot drift from what the client builds its calls out of, and the
 * tokens leave only as cookies — never in a body a script could read.
 */
@Controller()
export class RegistrationController {
  constructor(
    private readonly cookies: SessionCookies,
    private readonly register: RegisterUserUseCase,
    private readonly signIn: SignInUseCase,
  ) {}

  @Post('api/v1/auth/register')
  async registerUser(
    @Body(REGISTER) body: RegisterBody,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ user: UserView }> {
    const result = await this.register.execute({ ...body, ...callerFrom(request) });

    return this.begin(result, reply, authContract.register.status);
  }

  @Post('api/v1/auth/login')
  async login(
    @Body(LOGIN) body: LoginBody,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ user: UserView }> {
    const result = await this.signIn.execute({ ...body, ...callerFrom(request) });

    return this.begin(result, reply, authContract.login.status);
  }

  /** A failure is thrown rather than shaped here, so one filter words all of them. */
  private begin(
    result: Result<AuthResult, Error>,
    reply: FastifyReply,
    status: number,
  ): { user: UserView } {
    if (!result.ok) throw result.error;

    this.cookies.set(reply, result.value.session);
    reply.status(status);

    return { user: toUserView(result.value.user) };
  }
}
