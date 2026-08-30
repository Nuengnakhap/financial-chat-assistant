import type { AppConfig } from '@fca/config';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { CredentialPolicy } from './application/credential-policy';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { PersistenceModule } from '../shared/persistence/persistence.module';
import { RedisModule } from '../shared/redis/redis.module';
import { AUTH_THROTTLE } from './application/ports/auth-throttle';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { TOKEN_ISSUER } from './application/ports/token-issuer';
import { SessionIssuer } from './application/session-issuer';
import { DescribeUserUseCase } from './application/use-cases/describe-user.use-case';
import { RegisterUserUseCase } from './application/use-cases/register-user.use-case';
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
import { SessionGuard } from './presentation/session.guard';

/**
 * Every binding for signing in, in one place. A use case names a port and gets
 * whatever this file says implements it, so a test swaps the adapter without
 * the use case knowing there was a choice.
 */
@Module({
  // `AppModule` is global, so the config and the logger arrive without asking.
  // These two are not, and a provider is only visible where it is imported.
  imports: [PersistenceModule, RedisModule],
  controllers: [RegistrationController, SessionController, CurrentUserController],
  providers: [
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_ISSUER, useClass: FastJwtTokenIssuer },
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
    SessionCookies,
    SessionGuard,
    // Global: every mutation from here on carries session cookies, and the one
    // that forgets the check is the one that would not be noticed.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [RegisterUserUseCase, SignInUseCase, RotateRefreshTokenUseCase, SignOutUseCase],
})
export class IdentityModule {}
