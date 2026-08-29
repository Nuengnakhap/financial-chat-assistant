#!/usr/bin/env node
/**
 * Proves the data stack behaves as designed, including the guarantees that the
 * application layer is not allowed to be the only thing enforcing:
 *
 *   - the dump loaded completely
 *   - llm_reader can read financial_data
 *   - llm_reader cannot write, cannot read any other table, and cannot run a long query
 *   - Redis is reachable and will not evict budget counters
 *
 * Exits non-zero on the first failed check.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(repoRoot, 'infra/docker-compose.yml');

let failures = 0;

function compose(args) {
  return spawnSync('docker', ['compose', '-f', composeFile, ...args], { encoding: 'utf8' });
}

function psql(user, sql) {
  const result = compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAq',
    '-U',
    user,
    '-d',
    'financial_chat',
    '-c',
    sql,
  ]);
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

function report(name, passed, detail) {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

/** A check that must succeed and return an expected value. */
function expectQuery({ name, user, sql, expected }) {
  const { ok, out, err } = psql(user, sql);
  if (!ok) return report(name, false, err.split('\n')[0]);
  report(name, out === expected, `got "${out}", expected "${expected}"`);
}

/** A check that must fail, with an error message containing `fragment`. */
function expectDenied({ name, user, sql, fragment }) {
  const { ok, err } = psql(user, sql);
  if (ok) return report(name, false, 'statement unexpectedly succeeded');
  const matched = err.toLowerCase().includes(fragment.toLowerCase());
  report(name, matched, matched ? undefined : `unexpected error: ${err.split('\n')[0]}`);
}

console.log('Postgres — data:');
expectQuery({
  name: 'financial_data has 192 rows',
  user: 'app',
  sql: 'SELECT count(*) FROM financial_data;',
  expected: '192',
});
// 49 companies, not the 48 stated in the brief: 47 have four years each, BlackRock
// and Shopify have two. 47*4 + 2 + 2 = 192.
expectQuery({
  name: '49 companies, 2022-2025',
  user: 'app',
  sql: "SELECT count(DISTINCT company) || '/' || min(year) || '-' || max(year) FROM financial_data;",
  expected: '49/2022-2025',
});
expectQuery({
  name: 'indexes created',
  user: 'app',
  sql: "SELECT count(*) FROM pg_indexes WHERE tablename = 'financial_data';",
  expected: '3',
});

console.log('\nPostgres — llm_reader privileges:');
expectQuery({
  name: 'can read financial_data',
  user: 'llm_reader',
  sql: 'SELECT count(*) FROM financial_data;',
  expected: '192',
});
expectDenied({
  name: 'cannot INSERT',
  user: 'llm_reader',
  sql: "INSERT INTO financial_data (company) VALUES ('x');",
  fragment: 'read-only transaction',
});
expectDenied({
  name: 'cannot UPDATE',
  user: 'llm_reader',
  sql: 'UPDATE financial_data SET revenue = 0;',
  fragment: 'read-only transaction',
});
expectDenied({
  name: 'cannot DROP',
  user: 'llm_reader',
  sql: 'DROP TABLE financial_data;',
  fragment: 'read-only transaction',
});

// A table the role was never granted access to. Created and removed as `app`.
psql('app', 'CREATE TABLE IF NOT EXISTS privilege_probe (id int);');
expectDenied({
  name: 'cannot read other tables',
  user: 'llm_reader',
  sql: 'SELECT * FROM privilege_probe;',
  fragment: 'permission denied',
});
psql('app', 'DROP TABLE IF EXISTS privilege_probe;');

expectDenied({
  name: 'long queries are cut off at 3s',
  user: 'llm_reader',
  sql: 'SELECT pg_sleep(5);',
  fragment: 'statement timeout',
});

console.log('\nRedis:');
const ping = compose(['exec', '-T', 'redis', 'redis-cli', 'ping']);
report('reachable', (ping.stdout ?? '').trim() === 'PONG');
const policy = compose(['exec', '-T', 'redis', 'redis-cli', 'config', 'get', 'maxmemory-policy']);
const policyValue = (policy.stdout ?? '').trim().split('\n').pop()?.trim();
report('maxmemory-policy is noeviction', policyValue === 'noeviction', `got "${policyValue}"`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
