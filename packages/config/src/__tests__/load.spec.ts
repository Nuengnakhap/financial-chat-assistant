import { describe, expect, it } from 'vitest';

import { SECRET_ENV_KEYS } from '../env.schema';
import { ConfigError, loadConfig, type EnvSource } from '../load';

const VALID: EnvSource = {
  DATABASE_URL: 'postgresql://app_runtime:pw@localhost:5432/financial_chat',
  MIGRATION_DATABASE_URL: 'postgresql://app:pw@localhost:5432/financial_chat',
  FINANCIAL_DB_URL: 'postgresql://llm_reader:pw@localhost:5432/financial_chat',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test',
  USAGE_LIMIT_USD: '1',
  JWT_SECRET: 'x'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173',
};

const withEnv = (overrides: EnvSource): EnvSource => ({ ...VALID, ...overrides });

describe('a valid environment', () => {
  it('groups the flat variables into sections', () => {
    const config = loadConfig(VALID);

    expect(config.database.financialUrl).toContain('llm_reader');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.auth.jwtSecret).toHaveLength(32);
  });

  it('applies the documented defaults when a variable is absent', () => {
    const config = loadConfig(VALID);

    expect(config.nodeEnv).toBe('development');
    expect(config.app.port).toBe(3000);
    expect(config.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.llm.model).toBe('gpt-5.6-luna');
    expect(config.usage.windowSeconds).toBe(3600);
    expect(config.auth.accessTokenTtlMs).toBe(900_000);
    expect(config.auth.refreshTokenTtlDays).toBe(30);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.app.otlpEndpoint).toBeNull();
  });

  it.each([
    ['90s', 90_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['30d', 2_592_000_000],
  ])('reads ACCESS_TOKEN_TTL=%s as %i milliseconds', (value, ms) => {
    // The unit is the whole point of parsing here: getting it wrong by a factor
    // of a thousand produces a token that either expires instantly or outlives
    // the session it was meant to bound, and neither shows up as an error.
    expect(loadConfig(withEnv({ ACCESS_TOKEN_TTL: value })).auth.accessTokenTtlMs).toBe(ms);
  });

  it('turns numeric strings into numbers, not strings that look like numbers', () => {
    const config = loadConfig(withEnv({ API_PORT: '4000', USAGE_LIMIT_USD: '0.001' }));

    expect(config.app.port).toBe(4000);
    expect(config.usage.limitUsd).toBeCloseTo(0.001, 9);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    ['1', true],
    ['false', false],
    ['no', false],
    ['off', false],
    ['0', false],
  ])('reads COOKIE_SECURE=%s as %s', (value, expected) => {
    // Every spelling an operator plausibly types, so a `.env` typo cannot leave
    // cookies insecure by being silently unparseable.
    expect(loadConfig(withEnv({ COOKIE_SECURE: value })).auth.cookieSecure).toBe(expected);
  });

  it('treats an empty OTLP endpoint as unconfigured rather than invalid', () => {
    expect(loadConfig(withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).app.otlpEndpoint).toBeNull();
    expect(
      loadConfig(withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).app.otlpEndpoint,
    ).toBe('http://otel:4318');
  });
});

describe('an invalid environment', () => {
  it.each([
    ['DATABASE_URL', 'redis://localhost:6379'],
    ['REDIS_URL', 'postgresql://localhost:5432/x'],
    ['OPENAI_BASE_URL', 'not-a-url'],
    ['API_PORT', '70000'],
    ['API_PORT', '3000.5'],
    ['USAGE_LIMIT_USD', '0'],
    ['USAGE_LIMIT_USD', 'NaN'],
    ['USAGE_WINDOW_SECONDS', '-1'],
    ['ACCESS_TOKEN_TTL', '15 minutes'],
    // The shape matches; the value does not. A token that has already expired
    // when it is issued would fail on the request after the one that made it.
    ['ACCESS_TOKEN_TTL', '0s'],
    ['ACCESS_TOKEN_TTL', '0d'],
    ['COOKIE_SECURE', 'maybe'],
    ['COOKIE_SECURE', ''],
    ['NODE_ENV', 'staging'],
  ])('rejects %s = %o', (key, value) => {
    expect(() => loadConfig(withEnv({ [key]: value }))).toThrow(ConfigError);
  });

  it('rejects a JWT secret short enough to brute force', () => {
    expect(() => loadConfig(withEnv({ JWT_SECRET: 'short' }))).toThrow(/at least 32 characters/);
  });

  it('reports every problem at once, not one per restart', () => {
    let issues: readonly string[] = [];
    try {
      loadConfig({ ...VALID, DATABASE_URL: 'nope', REDIS_URL: 'nope', WEB_ORIGIN: 'nope' });
    } catch (error) {
      if (error instanceof ConfigError) issues = error.issues;
    }

    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('DATABASE_URL');
    expect(issues.join('\n')).toContain('WEB_ORIGIN');
  });

  it('names a missing variable instead of failing later at the driver', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID;

    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('still says something useful when handed no environment at all', () => {
    // A caller passing the wrong thing entirely gets a labelled issue, not a
    // blank bullet point.
    expect(() => loadConfig(null as unknown as EnvSource)).toThrow(/\(root\)/);
  });
});

describe('secret handling', () => {
  const secrets: EnvSource = {
    DATABASE_URL: 'postgresql://app:hunter2-db@localhost:5432/x',
    REDIS_URL: 'redis://:hunter2-redis@localhost:6379',
    OPENAI_API_KEY: 'sk-hunter2-openai',
    JWT_SECRET: 'hunter2-jwt-secret-that-is-long-enough',
  };

  it('never puts a secret value in the error message', () => {
    // Every secret is present but WEB_ORIGIN is broken, so the whole parse fails
    // with the secrets in hand — the moment a naive implementation echoes them.
    let message = '';
    try {
      loadConfig({ ...VALID, ...secrets, WEB_ORIGIN: 'not-a-url' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('WEB_ORIGIN');
    for (const value of Object.values(secrets)) {
      expect(message).not.toContain(value);
    }
    expect(message).not.toContain('hunter2');
  });

  it('marks every credential-bearing variable as secret', () => {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'OPENAI_API_KEY', 'JWT_SECRET']) {
      expect(SECRET_ENV_KEYS.has(key)).toBe(true);
    }
    expect(SECRET_ENV_KEYS.has('API_PORT')).toBe(false);
  });
});
