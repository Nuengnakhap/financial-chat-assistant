import { z } from 'zod';

/**
 * The shape of the environment, and the only place that decides what a valid
 * one looks like. Every rule here exists because the failure it prevents is
 * otherwise diagnosed at the wrong moment: a Redis URL pasted into
 * `DATABASE_URL` surfaces as a driver error minutes into a request, and a short
 * `JWT_SECRET` surfaces never.
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL');

const redisUrl = z.string().regex(/^rediss?:\/\/\S+$/, 'must be a redis:// or rediss:// URL');

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** Rejects `NaN` and `Infinity` before they become a number, unlike a bare cast. */
const decimal = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a decimal number')
    .transform(Number)
    .pipe(z.number().min(min).max(max));

/**
 * Parsed to milliseconds here rather than passed on as text, so nothing
 * downstream has to agree with us about what `m` means.
 */
const MS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'must look like 15m, 24h or 30d')
  .transform((value) => {
    const unit = value.slice(-1);
    return Number(value.slice(0, -1)) * (MS_PER_UNIT[unit] ?? 0);
  })
  .pipe(z.number().int().positive());

/** Empty means "not configured", which is different from a malformed value. */
const optionalUrl = z
  .union([z.literal(''), z.url()])
  .transform((value) => (value === '' ? null : value));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: postgresUrl,
  MIGRATION_DATABASE_URL: postgresUrl,
  FINANCIAL_DB_URL: postgresUrl,
  REDIS_URL: redisUrl,

  OPENAI_API_KEY: z.string().min(1, 'is required; local providers accept any placeholder'),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.6-luna'),
  LLM_MAX_OUTPUT_TOKENS: wholeNumber(1, 128_000).default(1_500),
  LLM_REQUEST_TIMEOUT_MS: wholeNumber(1_000, 600_000).default(60_000),

  // Capped far below 2^53 micro-USD so the conversion to MicroUsd stays exact.
  USAGE_LIMIT_USD: decimal(0.000_001, 1_000_000),
  USAGE_WINDOW_SECONDS: wholeNumber(1, 2_678_400).default(3_600),

  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  // `prefault` not `default`: the fallback is the text a person writes, and it
  // goes through the same parse as a value from the environment.
  ACCESS_TOKEN_TTL: duration.prefault('15m'),
  REFRESH_TOKEN_TTL_DAYS: wholeNumber(1, 365).default(30),
  COOKIE_SECURE: z.stringbool().default(false),

  API_PORT: wholeNumber(1, 65_535).default(3_000),
  WEB_ORIGIN: z.url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl.default(null),
});

export type Env = z.infer<typeof envSchema>;

/** Variables whose value must never reach a log line or an error message. */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'FINANCIAL_DB_URL',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'JWT_SECRET',
]);

export const ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);
