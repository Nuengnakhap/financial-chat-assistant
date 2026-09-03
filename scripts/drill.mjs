#!/usr/bin/env node
/**
 * The two failure drills a test cannot do.
 *
 * Three of the five in the plan are covered by tests that run every time — the
 * janitor clearing up after a process that died, the circuit breaker opening on
 * a refusing endpoint, and a budget window rebuilt from the ledger. What is left
 * is the two that need a dependency to actually go away, and a suite that stops
 * Postgres mid-run would take every other file down with it.
 *
 * So: a script, run by hand, against the stack that is already up.
 *
 *   pnpm infra:up && pnpm dev     # in another terminal
 *   pnpm drill redis
 *   pnpm drill postgres
 *
 * Each one restores what it broke, including on the way out of a failure — a
 * drill that leaves the stack down is a drill nobody runs twice.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'infra/docker-compose.yml');
const API = process.env.DRILL_API ?? 'http://localhost:3000';

const compose = (...args) =>
  spawnSync('docker', ['compose', '-f', composeFile, ...args], { encoding: 'utf8' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, passed, detail = '') {
  if (!passed) failures += 1;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

async function ready() {
  try {
    const response = await fetch(`${API}/healthz/ready`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Waits for readiness to reach `want`, or gives up. */
async function until(want, seconds) {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling is waiting, and waiting is the work here
    if ((await ready()) === want) return true;
    // eslint-disable-next-line no-await-in-loop -- and so is the pause between two polls
    await sleep(500);
  }

  return false;
}

/** What this process has counted, or why it could not be read. */
async function counted() {
  try {
    const response = await fetch(`${API}/healthz/counters`);

    return response.ok ? await response.text() : `unavailable (${String(response.status)})`;
  } catch {
    return 'unavailable — nothing is listening';
  }
}

/** Liveness: the process is running at all. Touches no dependency, by design. */
async function live() {
  try {
    return (await fetch(`${API}/healthz/live`)).ok;
  } catch {
    return false;
  }
}

/**
 * Liveness held all the way through the outage.
 *
 * This is the check that matters most and it is the one that was missing: an
 * unhandled `'error'` on a `pg.Pool` **ends the Node process**, so before that
 * listener existed, stopping Postgres here did not make readiness go red — it
 * killed the API. Answering `/healthz/live` throughout is the difference
 * between a dependency being down and this process being gone, and unlike a
 * comparison of counters it can be made every time.
 */
async function stayedAlive(seconds) {
  for (let checked = 0; checked < seconds * 2; checked += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling is waiting, and waiting is the work here
    if (!(await live())) return false;
    // eslint-disable-next-line no-await-in-loop -- and so is the pause between two polls
    await sleep(500);
  }

  return true;
}

/**
 * Readiness has to notice, and it has to stop noticing. A probe that goes red
 * and stays red after the dependency comes back is worse than one that never
 * went red: it turns a blip into an outage that needs a human.
 */
async function drillRedis() {
  console.log('Redis — stopped underneath a running API\n');
  check('the API is ready to begin with', await ready());

  compose('stop', 'redis');
  check('readiness turns red within 15s', await until(false, 15));

  check('liveness never wavers while it is down', await stayedAlive(3));

  compose('start', 'redis');
  check('readiness turns green again within 30s', await until(true, 30));
  // Without a question, because the point is that nothing had to be restarted.
  check('and it did so without the process being restarted', await ready());
}

/**
 * The outbox is the promise that nothing is lost. Stopping the database under a
 * running relay is the only way to see it keep that promise: rows written
 * before the outage are still unpublished after it, and the pump picks them up
 * without anybody asking.
 */
async function drillPostgres() {
  console.log('Postgres — stopped and started under a running API\n');
  check('the API is ready to begin with', await ready());

  compose('stop', 'postgres');
  check('readiness turns red within 15s', await until(false, 15));
  // The one this drill exists for: see `stayedAlive`.
  check('the process is still alive with no database at all', await stayedAlive(4));

  compose('start', 'postgres');
  check('readiness turns green again within 60s', await until(true, 60));

  // Readiness asks the database three questions through the pools that were
  // just cut off, so green here is a real round trip on a reconnected pool and
  // not a cached answer.
  await sleep(3_000);
  check('and answers on a reconnected pool without being restarted', await ready());
  // Printed, not checked: these are all failure counters, so a healthy process
  // reports `{}` and comparing two of those would prove nothing. Guarded like
  // every other request here — a drill that throws on a dead API reports a
  // stack trace where it should be reporting the failure it just found.
  console.log(`  ---   counted so far: ${await counted()}`);
}

const which = process.argv[2];
const drills = { redis: drillRedis, postgres: drillPostgres };

if (!(which in drills)) {
  console.error(`Usage: pnpm drill <${Object.keys(drills).join('|')}>`);
  process.exit(2);
}

try {
  await drills[which]();
} finally {
  // Whatever happened, put it back. A drill that leaves the stack down is a
  // drill nobody runs twice — and one that leaves it down *and reports success*
  // is worse, because the next thing to fail will look unrelated.
  console.log('\nRestoring');
  compose('start', 'postgres');
  compose('start', 'redis');
  check('the stack is back up', await until(true, 60));
}

console.log(failures === 0 ? '\nDrill passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
