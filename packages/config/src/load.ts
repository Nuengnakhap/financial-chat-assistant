import { envSchema, type Env } from './env.schema';

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly app: {
    readonly port: number;
    readonly webOrigin: string;
    readonly otlpEndpoint: string | null;
  };
  readonly database: {
    readonly url: string;
    readonly migrationUrl: string;
    /** Read-only role used for SQL written by the model. Never the runtime role. */
    readonly financialUrl: string;
  };
  readonly redis: { readonly url: string };
  readonly llm: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly maxOutputTokens: number;
    readonly requestTimeoutMs: number;
  };
  readonly usage: {
    /** Converted to `MicroUsd` exactly once, by the budget module. */
    readonly limitUsd: number;
    readonly windowSeconds: number;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly accessTokenTtl: string;
    readonly refreshTokenTtlDays: number;
    readonly cookieSecure: boolean;
  };
}

/**
 * Carries which variables are wrong and why, never what they contained — an
 * invalid `DATABASE_URL` still holds a password, and a boot failure is exactly
 * when a stack trace ends up in a paste buffer.
 */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Throws rather than returning a `Result`: a misconfigured environment is a
 * deployment bug, and the only correct response is to stop before serving.
 */
export function loadConfig(source: EnvSource): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return toAppConfig(parsed.data);
}

function toAppConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    app: {
      port: env.API_PORT,
      webOrigin: env.WEB_ORIGIN,
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    database: {
      url: env.DATABASE_URL,
      migrationUrl: env.MIGRATION_DATABASE_URL,
      financialUrl: env.FINANCIAL_DB_URL,
    },
    redis: { url: env.REDIS_URL },
    llm: {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    },
    usage: { limitUsd: env.USAGE_LIMIT_USD, windowSeconds: env.USAGE_WINDOW_SECONDS },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      cookieSecure: env.COOKIE_SECURE,
    },
  };
}
