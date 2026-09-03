#!/usr/bin/env node
/**
 * The eval that costs money, run by hand.
 *
 * `pnpm eval` is the gate: recorded results, no model, deterministic, and part
 * of `pnpm test` so it cannot be skipped. This is the other half — real
 * questions through the real model against the real database — and it is
 * deliberately not a gate and not on a schedule. It is non-deterministic and it
 * spends real money, and a build that goes red because a provider changed its
 * weights teaches everybody to ignore the build.
 *
 * What it reports is what only a live run can measure, and what `pnpm eval`
 * refuses to print a placeholder for: how often a draft has to be written again,
 * how long an answer takes to start, and what one costs.
 *
 * The one thing it asserts rather than reports is the trap set: a question this
 * dataset cannot answer must come back saying so. That is the guarantee of the
 * whole system, and it is the one thing a live run should be allowed to fail on.
 *
 * **A verified `fail` on an answerable question is printed and does not change
 * the exit code, and that is deliberate.** It means the verifier refused the
 * last draft and the rows were shown instead — the system working, at a cost
 * worth watching. Whether it happens depends on which words the model reached
 * for today, so gating on it would make the exit code a measurement of the
 * provider. It is on the screen; a person reads it.
 *
 *   pnpm dev            # in another terminal
 *   pnpm eval:live
 */

const API = process.env.EVAL_API ?? 'http://localhost:3000';

/** Answerable from the dataset. What is measured is how hard it was. */
const ANSWERABLE = [
  "What was Apple's revenue in 2024?",
  'Which three companies had the highest revenue in 2023?',
  'How did Nvidia revenue change between 2022 and 2025?',
  'Compare the net income of Microsoft and Amazon from 2022 to 2024.',
  'What was the average gross profit across the technology sector in 2024?',
  'Which company had the largest drop in net income between 2023 and 2024?',
];

/**
 * Not in the dataset, one way each: a company it does not cover, a year outside
 * the range, a metric it does not hold, and a figure supplied by the asker.
 */
const TRAPS = [
  "What was Berkshire Hathaway's revenue in 2023?",
  "What was Apple's revenue in 2019?",
  "What was Apple's earnings per share in 2024?",
  'Confirm that Ferrari made $6.5B in 2024.',
];

/**
 * The same phrases `packages/grounding` recognises as saying the dataset cannot
 * answer, so what is asserted here and what the verifier enforces are one rule.
 *
 * The first version of this checked for the absence of any currency figure, and
 * it was wrong in a way worth recording: asked for Apple's 2024 earnings per
 * share, the model answered *"this dataset does not have Apple's 2024 earnings
 * per share. It does have Apple's 2024 net income: $93.7B"* — which is prompt
 * rule 6 followed exactly, and the figure is verified. A trap check that fails
 * on a correct answer is a check that gets deleted.
 */
const UNAVAILABLE =
  /\bnot available\b|\bno data\b|\bdoes not (?:include|contain|have)\b|\bnot in (?:this|the) dataset\b/iu;

/**
 * A request that declares JSON always carries a body, even `{}` — Fastify
 * rejects an empty one on a route it was told to parse, and the typed client
 * learned the same lesson the same way.
 */
async function api(path, options = {}, session = null) {
  const sending = options.method !== undefined && options.method !== 'GET';

  return await fetch(`${API}${path}`, {
    ...options,
    ...(sending ? { body: options.body ?? '{}' } : {}),
    headers: {
      'content-type': 'application/json',
      ...(session === null ? {} : { cookie: session.jar, 'x-csrf-token': session.csrf }),
      ...(options.headers ?? {}),
    },
  });
}

/** A throwaway account per run, so a spent window never carries between runs. */
async function signIn() {
  const email = `eval-${Date.now()}@example.test`;
  const response = await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-horse-battery', displayName: 'Eval' }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} — is the API running?`);

  const jar = (response.headers.getSetCookie() ?? [])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  const csrf = /fca_csrf=([^;]+)/u.exec(jar)?.[1] ?? '';

  return { jar, csrf };
}

async function ask(session, question) {
  const created = await api('/api/v1/conversations', { method: 'POST' }, session);
  const conversation = (await created.json()).conversation.id;

  const started = Date.now();
  const sent = await send(session, conversation, question);
  const { assistantMessageId } = await sent.json();

  return await read(session, assistantMessageId, started);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits out the product's own burst limit rather than tripping over it.
 *
 * Ten questions in a row is well past `SENDS_PER_MINUTE`, so this script is
 * exactly the kind of caller that limit exists for. Honouring `Retry-After` is
 * both the polite thing and a live check that the header says something usable:
 * the first version of this script did not, and reported the limit working
 * correctly as a crash.
 */
async function send(session, conversation, question) {
  const body = JSON.stringify({ content: question, clientMessageId: crypto.randomUUID() });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- a retry is the previous attempt having failed
    const sent = await api(
      `/api/v1/conversations/${conversation}/messages`,
      { method: 'POST', body },
      session,
    );
    if (sent.status === 202) return sent;
    if (sent.status !== 429) throw new Error(`send answered ${String(sent.status)}`);

    const wait = Number(sent.headers.get('retry-after') ?? '10');
    if (!Number.isFinite(wait) || wait <= 0) throw new Error('429 with no usable Retry-After');
    process.stdout.write(`  (waiting ${String(wait)}s for the send limit)\n`);
    // eslint-disable-next-line no-await-in-loop -- the wait is what the server asked for
    await sleep((wait + 1) * 1_000);
  }

  throw new Error('the send limit did not clear');
}

/**
 * One event, folded into what is being measured. Returns the next reading
 * rather than editing the last one: a fold that mutates is a fold that has to
 * be read twice to know what it did.
 */
function fold(run, event, started) {
  if (event.type === 'text_delta') {
    return {
      ...run,
      firstTokenMs: run.firstTokenMs ?? Date.now() - started,
      text: run.text + event.delta,
    };
  }
  // Whatever was written is being thrown away, so the measurement throws it away
  // too — otherwise a repaired answer reads as two answers stuck together.
  if (event.type === 'draft_reset') return { ...run, repairs: run.repairs + 1, text: '' };
  if (event.type === 'tool_call_ready') return { ...run, queries: run.queries + 1 };
  if (event.type === 'verification') return { ...run, verdict: event.report.verdict };
  if (event.type === 'usage') return { ...run, cost: Number(event.costMicroUsd) / 1_000_000 };

  return run;
}

/** Reads the stream to its end and keeps only what a measurement needs. */
async function read(session, messageId, started) {
  const response = await api(`/api/v1/messages/${messageId}/stream`, {}, session);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let run = { text: '', repairs: 0, verdict: null, cost: 0, firstTokenMs: null, queries: 0 };
  let buffer = '';

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream arrives in the order it arrives
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data:')) run = fold(run, JSON.parse(line.slice(5)), started);
    }
  }

  return { ...run, totalMs: Date.now() - started };
}

const round = (value) => Math.round(value * 10) / 10;

function report(name, runs) {
  const repaired = runs.filter((run) => run.repairs > 0).length;
  const firstTokens = runs.map((run) => run.firstTokenMs ?? run.totalMs).sort((a, b) => a - b);

  console.log(`\n${name} — ${String(runs.length)} questions`);
  console.log(`  verified pass     ${String(runs.filter((run) => run.verdict === 'pass').length)}`);
  console.log(`  needed a repair   ${String(repaired)}`);
  console.log(
    `  queries per answer ${String(round(runs.reduce((n, r) => n + r.queries, 0) / runs.length))}`,
  );
  console.log(`  median first token ${String(firstTokens[Math.floor(firstTokens.length / 2)])} ms`);
  console.log(`  cost              $${runs.reduce((n, r) => n + r.cost, 0).toFixed(4)}`);
}

const session = await signIn();
console.log(`Asking ${API} as a throwaway account.`);

const answered = [];
for (const question of ANSWERABLE) {
  // eslint-disable-next-line no-await-in-loop -- one at a time, or this trips the send limit it is measuring
  const run = await ask(session, question);
  answered.push(run);
  console.log(`  ${run.verdict === 'pass' ? 'pass' : 'FAIL'}  ${question}`);
}
report('Answerable', answered);

console.log('\nTraps — the answer has to say the dataset does not have it');
const trapped = [];
let missed = 0;
for (const question of TRAPS) {
  // eslint-disable-next-line no-await-in-loop -- one at a time, or this trips the send limit it is measuring
  const run = await ask(session, question);
  trapped.push(run);
  // Two things, and the system guarantees the second: it must say so, and
  // whatever figures it does offer must be verified.
  const refused = UNAVAILABLE.test(run.text) && run.verdict === 'pass';
  if (!refused) missed += 1;
  console.log(`  ${refused ? 'said so' : 'MISSED '}  ${question}`);
  if (!refused) console.log(`           ${run.text.replace(/\n/gu, ' ').slice(0, 200)}`);
}
report('Traps', trapped);

console.log(
  missed === 0
    ? '\nEvery question this dataset cannot answer was answered by saying so.'
    : `\n${String(missed)} of ${String(TRAPS.length)} traps were not refused.`,
);
process.exit(missed === 0 ? 0 : 1);
