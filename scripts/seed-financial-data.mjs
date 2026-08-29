#!/usr/bin/env node
/**
 * Loads the financial_data dump into the local Postgres container.
 *
 * Idempotent: the dump begins with DROP TABLE IF EXISTS, so re-running replaces the
 * table. Grants are re-applied afterwards because DROP TABLE discards them.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(repoRoot, 'infra/docker-compose.yml');

const EXPECTED_ROWS = 192;

/** Runs a SQL file that is mounted inside the container at /seed. */
function psqlFile(file, label) {
  run(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'app', '-d', 'financial_chat', '-f', `/seed/${file}`], label);
}

/** Runs a single statement and returns trimmed stdout. */
function psqlQuery(sql) {
  const result = compose(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-tAq', '-U', 'app', '-d', 'financial_chat', '-c', sql]);
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`query failed: ${sql}`);
  }
  return (result.stdout ?? '').trim();
}

function compose(args) {
  return spawnSync('docker', ['compose', '-f', composeFile, ...args], { encoding: 'utf8' });
}

function run(args, label) {
  process.stdout.write(`  ${label} ... `);
  const result = compose(args);
  if (result.status !== 0) {
    process.stdout.write('failed\n\n');
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exit(1);
  }
  process.stdout.write('ok\n');
}

function main() {
  const running = compose(['ps', '--status', 'running', '--services']);
  if (!(running.stdout ?? '').includes('postgres')) {
    console.error('Postgres is not running. Start it with: pnpm infra:up');
    process.exit(1);
  }

  console.log('Seeding financial_data:');
  psqlFile('financial_data.sql', 'load dump');
  psqlFile('grant-llm-reader.sql', 'apply llm_reader grants');
  psqlFile('post-seed-indexes.sql', 'create indexes');

  const rows = Number(psqlQuery('SELECT count(*) FROM financial_data;'));
  const [companies, minYear, maxYear] = psqlQuery(
    'SELECT count(DISTINCT company), min(year), max(year) FROM financial_data;',
  ).split('|');

  console.log(`\n  rows      ${rows}`);
  console.log(`  companies ${companies}`);
  console.log(`  years     ${minYear}-${maxYear}`);

  if (rows !== EXPECTED_ROWS) {
    console.error(`\nExpected ${EXPECTED_ROWS} rows, found ${rows}. The dump may be truncated.`);
    process.exit(1);
  }
  console.log('\nSeed complete.');
}

main();
