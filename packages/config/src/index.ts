/** The public surface. A deep import couples the caller to a file layout free to change. */

export { ENV_KEYS, SECRET_ENV_KEYS, envSchema, type Env } from './env.schema';
export { ConfigError, loadConfig, type AppConfig, type EnvSource } from './load';
