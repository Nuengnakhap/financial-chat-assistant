import type { RedisKey } from './keys';
import { luaScript } from './lua-script';
import type { RedisService } from './redis.service';

/**
 * How often something has happened lately, and whether it may happen again.
 *
 * A sorted set of timestamps rather than a counter with a TTL, because a
 * counter resets on a boundary: five attempts at 59 seconds and five more at 61
 * pass a limit of five per minute without ever having a minute containing five.
 *
 * One script because the trim, the count and the insert have to see the same
 * state — run as three commands, two callers both read a count of four and both
 * become the fifth.
 *
 * The answer is the milliseconds to wait, or 0 when it was allowed: the wait is
 * what a caller owes `Retry-After`, and only the script knows when the oldest
 * entry in the window falls out of it.
 */
const RECORD = luaScript(
  'sliding-window',
  `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, math.ceil(tonumber(oldest[2]) + window - now))
end

-- The member has to be unique or two attempts in the same millisecond count once.
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 0
`,
);

/** Forgetting a window is a one-line script, so the facade only ever speaks Lua. */
export const FORGET_WINDOW = luaScript('sliding-window-clear', 'return redis.call("DEL", KEYS[1])');

export interface Window {
  readonly windowMs: number;
  readonly limit: number;
}

/**
 * Records the occurrence and answers whether it was allowed, in that order and
 * atomically: asking first and counting afterwards lets a burst all read the
 * same count and all pass.
 */
export async function recordInWindow(
  redis: RedisService,
  key: RedisKey,
  window: Window,
): Promise<number> {
  const wait = await redis.runScript(
    RECORD,
    [key],
    [Date.now(), window.windowMs, window.limit, occurrence()],
  );

  return typeof wait === 'number' ? wait : 0;
}

const occurrence = (): string => `${String(Date.now())}:${crypto.randomUUID()}`;
