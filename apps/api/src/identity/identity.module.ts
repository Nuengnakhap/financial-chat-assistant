import type { AppConfig } from '@fca/config';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { CredentialPolicy } from './application/credential-policy';
import { SessionJanitor } from './application/session-janitor';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { PersistenceModule } from '../shared/persistence/persistence.module';
import { RedisModule } from '../shared/redis/redis.module';
import { AUTH_THROTTLE } from './application/ports/auth-throttle';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { TOKEN_ISSUER } from './application/ports/token-issuer';
import { SessionIssuer } from './application/session-issuer';
import { DescribeUserUseCase } from './application/use-cases/describe-user.use-case';
import { ListSessionsUseCase } from './application/use-cases/list-sessions.use-case';
import { PurgeDeadSessionsUseCase } from './application/use-cases/purge-dead-sessions.use-case';
import { RegisterUserUseCase } from './application/use-cases/register-user.use-case';
import { RevokeSessionUseCase } from './application/use-cases/revoke-session.use-case';
import { RotateRefreshTokenUseCase } from './application/use-cases/rotate-refresh-token.use-case';
import { SignInUseCase } from './application/use-cases/sign-in.use-case';
import { SignOutUseCase } from './application/use-cases/sign-out.use-case';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { FastJwtTokenIssuer } from './infrastructure/fast-jwt-token-issuer';
import {
  RedisAuthThrottle,
  THROTTLE_LIMITS,
  type ThrottleLimits,
} from './infrastructure/redis-auth-throttle';
import { CsrfGuard } from './presentation/csrf.guard';
import { CurrentUserController } from './presentation/current-user.controller';
import { RegistrationController } from './presentation/registration.controller';
import { SessionCookies } from './presentation/session-cookies';
import { SessionController } from './presentation/session.controller';
import { SessionsController } from './presentation/sessions.controller';
import { ACCESS_TOKEN_VERIFIER, SessionGuard } from '../shared/http/session.guard';

/**
 * Every binding for signing in, in one place. A use case names a port and gets
 * whatever this file says implements it, so a test swaps the adapter without
 * the use case knowing there was a choice.
 */
@Module({
  // `AppModule` is global, so the config and the logger arrive without asking.
  // These two are not, and a provider is only visible where it is imported.
  imports: [PersistenceModule, RedisModule],
  controllers: [
    RegistrationController,
    SessionController,
    CurrentUserController,
    SessionsController,
  ],
  providers: [
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_ISSUER, useClass: FastJwtTokenIssuer },
    // The guard asks for the narrow capability; the issuer that mints tokens is
    // what reads them, so there is one implementation rather than two that
    // could disagree about what a valid token is.
    { provide: ACCESS_TOKEN_VERIFIER, useExisting: TOKEN_ISSUER },
    {
      // Read from the environment rather than fixed in the adapter, because an
      // office behind one NAT is exactly the deployment that needs them raised.
      provide: THROTTLE_LIMITS,
      useFactory: (config: AppConfig): ThrottleLimits => config.auth.throttle,
      inject: [APP_CONFIG],
    },
    { provide: AUTH_THROTTLE, useClass: RedisAuthThrottle },
    SessionIssuer,
    CredentialPolicy,
    RegisterUserUseCase,
    SignInUseCase,
    RotateRefreshTokenUseCase,
    SignOutUseCase,
    DescribeUserUseCase,
    ListSessionsUseCase,
    RevokeSessionUseCase,
    PurgeDeadSessionsUseCase,
    SessionJanitor,
    SessionCookies,
    SessionGuard,
    // Global: every mutation from here on carries session cookies, and the one
    // that forgets the check is the one that would not be noticed.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  // `ACCESS_TOKEN_VERIFIER` leaves this module for one reason: `SessionGuard`
  // is what every other context puts in front of its routes, and a guard is
  // built in the injector of the module whose controller uses it. The issuer
  // itself stays in — nobody else has any business minting a token.
  exports: [
    RegisterUserUseCase,
    SignInUseCase,
    RotateRefreshTokenUseCase,
    SignOutUseCase,
    ACCESS_TOKEN_VERIFIER,
  ],
})
export class IdentityModule {}
