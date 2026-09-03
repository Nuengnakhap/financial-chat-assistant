import type { AppConfig } from '@fca/config';
import { MicroUsd, ReservationId, type Reservation, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../shared/config/app-config.token';
import { K, type RedisKey } from '../../shared/redis/keys';
import { luaScript } from '../../shared/redis/lua-script';
import { RedisService } from '../../shared/redis/redis.service';
import type { BudgetState, BudgetStore } from '../application/ports/budget.store';
import { USAGE_LEDGER, type UsageLedger } from '../application/ports/usage-ledger.port';

/**
 * A spending limit, held in one hash per person per window.
 *
 * `settled` is what has been spent, `reserved` is what is being spent right
 * now, and one `rsv:<id>` field per claim records how much to give back. Each
 * script is one round trip because each has to see one state: read a total,
 * then add to it in a second call, and two callers both read the total before
 * either adds.
 *
 * Lua numbers are doubles, so the comparison below is exact to 2^53 micro-USD —
 * about nine billion dollars — while `USAGE_LIMIT_USD` tops out at a million.
 * `HINCRBY` is 64-bit integer arithmetic and never sees a float at all.
 */
const RESERVE = luaScript(
  'budget-reserve',
  `
local settled  = tonumber(redis.call('HGET', KEYS[1], 'settled')  or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local amount   = tonumber(ARGV[1])

if settled + reserved + amount > tonumber(ARGV[2]) then
  return 0
end

redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HSET', KEYS[1], 'rsv:' .. ARGV[4], amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`,
);

/**
 * Settling twice adds once. Several writers can end one generation — the runner
 * that finished it, a stop that arrived, the janitor that found it abandoned —
 * and the claim itself is what decides which of them was first: it is gone
 * after the first, and a claim that is not there is a no-op rather than an
 * error, because by then the books are already closed.
 */
const SETTLE = luaScript(
  'budget-settle',
  `
local field = 'rsv:' .. ARGV[1]
local held  = tonumber(redis.call('HGET', KEYS[1], field) or '-1')
if held < 0 then return 0 end

redis.call('HDEL', KEYS[1], field)
redis.call('HINCRBY', KEYS[1], 'reserved', -held)
redis.call('HINCRBY', KEYS[1], 'settled', tonumber(ARGV[2]))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`,
);

/** As settle, without the charge: a generation that spent nothing owes nothing. */
const RELEASE = luaScript(
  'budget-release',
  `
local field = 'rsv:' .. ARGV[1]
local held  = tonumber(redis.call('HGET', KEYS[1], field) or '-1')
if held < 0 then return 0 end

redis.call('HDEL', KEYS[1], field)
redis.call('HINCRBY', KEYS[1], 'reserved', -held)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`,
);

/** Has this window already been read back from the ledger? One call, on every path. */
const IS_REBUILT = luaScript(
  'budget-is-rebuilt',
  `return redis.call('HEXISTS', KEYS[1], 'from_ledger')`,
);

/**
 * Puts a window's history back, once, in one step.
 *
 * The marker and the amount are set together on purpose. Claiming first and
 * adding afterwards leaves a gap in which the window says it has been rebuilt
 * and holds nothing — and anything asking for a reservation in that gap is
 * judged against an empty counter, which is exactly the total the ledger exists
 * to stop being lost.
 *
 * The total is added rather than assigned for a related reason: a claim settled
 * while the ledger was being read has already moved `settled`, and assigning
 * would throw that away. Both are increments, so both survive.
 */
const APPLY_REBUILD = luaScript(
  'budget-apply-rebuild',
  `
if redis.call('HSETNX', KEYS[1], 'from_ledger', '1') == 0 then return 0 end

local spent = tonumber(ARGV[1])
if spent > 0 then redis.call('HINCRBY', KEYS[1], 'settled', spent) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`,
);

/** Longer than the window, so a claim made in its last second can still be given back. */
const GRACE_SECONDS = 120;

@Injectable()
export class RedisLuaBudgetStore implements BudgetStore {
  private readonly limit: MicroUsd;
  private readonly windowSeconds: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(USAGE_LEDGER) private readonly ledger: UsageLedger,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limit = MicroUsd.fromUsd(config.usage.limitUsd);
    this.windowSeconds = config.usage.windowSeconds;
  }

  async reserve(userId: UserId, amount: MicroUsd): Promise<Reservation | null> {
    const windowStart = this.windowStart();
    await this.rebuildIfLost(userId, windowStart);
    const id = ReservationId.trusted(crypto.randomUUID());
    const granted = await this.redis.runScript(
      RESERVE,
      [K.budget(userId, windowStart)],
      [amount.toString(), this.limit.toString(), String(this.ttlSeconds), id],
    );

    return granted === 1 ? { userId, id, windowStart: new Date(windowStart * 1_000) } : null;
  }

  async settle(reservation: Reservation, actual: MicroUsd): Promise<void> {
    await this.redis.runScript(
      SETTLE,
      [this.keyOf(reservation)],
      [reservation.id, actual.toString(), String(this.ttlSeconds)],
    );
  }

  async release(reservation: Reservation): Promise<void> {
    await this.redis.runScript(
      RELEASE,
      [this.keyOf(reservation)],
      [reservation.id, String(this.ttlSeconds)],
    );
  }

  async read(userId: UserId): Promise<BudgetState> {
    const windowStart = this.windowStart();
    await this.rebuildIfLost(userId, windowStart);
    const held = await this.redis.readHash(K.budget(userId, windowStart));

    return {
      spent: amountIn(held, 'settled'),
      reserved: amountIn(held, 'reserved'),
      limit: this.limit,
      resetAt: new Date((windowStart + this.windowSeconds) * 1_000),
    };
  }

  /**
   * A window Redis has never seen might be a new one or might be one it has
   * forgotten, and from here the two look identical. So anything that touches
   * one reads the ledger — the record that outlives a restart — and puts back
   * what was spent before judging anything against it. A window already read
   * back costs one `HEXISTS`; a new one reads as zero.
   *
   * Every caller does its own read rather than waiting on whoever got there
   * first. Several arriving at once on a cold window therefore ask the database
   * the same question more than once — an indexed query for one person and one
   * hour — and in exchange nobody proceeds against a counter that has not been
   * restored yet. Waiting instead would mean a retry loop on the path where a
   * question is accepted, to save a query that happens once an hour.
   *
   * A ledger that cannot be read raises rather than carrying on. Refusing to
   * start a generation is the conservative half of that choice, and the next
   * request tries again — nothing has been marked as rebuilt, because the mark
   * and the amount go in together.
   */
  private async rebuildIfLost(userId: UserId, windowStart: number): Promise<void> {
    const key = K.budget(userId, windowStart);
    if ((await this.redis.runScript(IS_REBUILT, [key], [])) === 1) return;

    const spent = await this.ledger.spentIn(userId, new Date(windowStart * 1_000));

    await this.redis.runScript(APPLY_REBUILD, [key], [spent.toString(), String(this.ttlSeconds)]);
  }

  /** Fixed windows, so "when does this reset" has an answer a countdown can show. */
  private windowStart(now = Date.now()): number {
    return Math.floor(now / 1_000 / this.windowSeconds) * this.windowSeconds;
  }

  private get ttlSeconds(): number {
    return this.windowSeconds + GRACE_SECONDS;
  }

  private keyOf(reservation: Reservation): RedisKey {
    return K.budget(reservation.userId, Math.floor(reservation.windowStart.getTime() / 1_000));
  }
}

function amountIn(held: Readonly<Record<string, string>>, field: string): MicroUsd {
  const raw = held[field];
  // A hash that is not there reads as a window nobody has spent in, which is
  // what an expired key and a new window both are.
  if (raw === undefined || !/^-?\d+$/.test(raw)) return MicroUsd.ZERO;

  return MicroUsd.fromMicroString(raw);
}
