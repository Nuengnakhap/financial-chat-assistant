import type { AppConfig } from '@fca/config';
import type { GroundingReport } from '@fca/contracts';
import { MessageId, type ConversationId, type UserId } from '@fca/domain';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TaskRegistry } from '../../bootstrap/task-registry';
import { delay } from '../../shared/async/timeouts';
import { testConfig } from '../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../shared/observability/app-logger';
import {
  insertConversation,
  insertUser,
  startHarness,
  type Harness,
} from '../../shared/persistence/__tests__/harness';
import { DatabaseService } from '../../shared/persistence/database.service';
import { messages } from '../../shared/persistence/schema';
import { K } from '../../shared/redis/keys';
import { RedisService } from '../../shared/redis/redis.service';
import { StreamMultiplexer } from '../../shared/redis/stream-multiplexer';
import type { AgentEvent } from '../application/agent-events';
import type { AgentRunner } from '../application/agent-runner';
import { GenerationSupervisor } from '../application/generation-supervisor';
import { STREAM_START, type StoredStreamEvent } from '../application/ports/generation-events.port';
import { RunGenerationUseCase } from '../application/run-generation.use-case';
import { EndAbandonedGenerationsUseCase } from '../application/use-cases/end-abandoned-generations.use-case';
import { StopGenerationUseCase } from '../application/use-cases/stop-generation.use-case';
import { WatchGenerationUseCase } from '../application/use-cases/watch-generation.use-case';
import { DrizzleGenerationMessages } from '../infrastructure/drizzle-generation-messages';
import { GenerationStream } from '../infrastructure/generation-stream';
import { GenerationSubscriber } from '../infrastructure/generation.subscriber';
import { RedisGenerationStops } from '../infrastructure/redis-generation-stops';

/**
 * The whole detached path, against a real PostgreSQL and a real Redis, with only
 * the model replaced: a question is stored with an outbox event, a runner picks
 * the event up, and what it writes is read back over a stream that survives the
 * reader going away.
 *
 * These are the properties nothing smaller can answer for — a client that
 * disconnects and resumes by id sees every event exactly once, a stop published
 * from one place reaches a generation running in another, and a row nobody is
 * writing to any more does not stay `generating` for ever.
 */

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function urls(): { database: string; redis: string } {
  const database = process.env['TEST_DATABASE_URL'];
  const redis = process.env['TEST_REDIS_URL'];
  if (database === undefined || redis === undefined) {
    throw new Error('the integration global setup did not run');
  }

  return { database, redis };
}

const REPORT: GroundingReport = {
  verdict: 'pass',
  checkedClaims: [
    {
      text: '$391.0B',
      value: '391035000000',
      toolCallId: 'call_1',
      rowIndex: 0,
      column: 'revenue',
    },
  ],
  violations: [],
};

/** What the runner would produce, paced so a test can attach in the middle of it. */
interface Script {
  readonly events: readonly AgentEvent[];
  /** Milliseconds between one event and the next. */
  readonly everyMs: number;
}

let script: Script;
/** Set by the fake runner, so a test can watch the signal the supervisor built. */
let lastSignal: AbortSignal | null = null;

const runner = {
  run: async function* run(_request: unknown, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    lastSignal = signal;
    for (const event of script.events) {
      // eslint-disable-next-line no-await-in-loop -- paced on purpose, like a real stream.
      await delay(script.everyMs);
      if (signal.aborted) {
        yield { type: 'finished', outcome: 'stopped', text: 'Apple', report: null };
        return;
      }
      yield event;
    }
  },
} as unknown as AgentRunner;

const answered: readonly AgentEvent[] = [
  { type: 'generation_started', model: 'a-model' },
  { type: 'tool_call_ready', id: 'call_1', sql: 'SELECT revenue FROM financial_data' },
  { type: 'text_delta', delta: 'Apple earned ' },
  { type: 'text_delta', delta: '$391.0B' },
  { type: 'verification', report: REPORT },
  { type: 'finished', outcome: 'answered', text: 'Apple earned $391.0B', report: REPORT },
];

let harness: Harness;
let database: DatabaseService;
let redis: RedisService;
let admin: Redis;
let tasks: TaskRegistry;
let streams: StreamMultiplexer;
let stream: GenerationStream;
let store: DrizzleGenerationMessages;
let stops: RedisGenerationStops;
let supervisor: GenerationSupervisor;
let subscriber: GenerationSubscriber;
let watch: WatchGenerationUseCase;
let stopping: StopGenerationUseCase;
let janitor: EndAbandonedGenerationsUseCase;

let ada: UserId;
let room: ConversationId;

beforeAll(async () => {
  harness = await startHarness();
  const config: AppConfig = {
    ...testConfig(),
    database: { ...testConfig().database, url: urls().database },
    redis: { url: urls().redis },
  };
  database = new DatabaseService(config);
  redis = new RedisService(config, silent);
  admin = new Redis(urls().redis);
  store = new DrizzleGenerationMessages(database);
}, 120_000);

afterAll(async () => {
  await redis.onModuleDestroy();
  await database.onModuleDestroy();
  await admin.quit();
  await harness.close();
});

/**
 * A registry per test, not per file: draining one refuses every task after it,
 * which is what shutdown means — and a second test would then quietly run no
 * generation at all and assert against an empty stream.
 */
beforeEach(async () => {
  await harness.reset();
  await admin.flushall();
  ada = await insertUser(harness.db, 'ada@example.com');
  room = await insertConversation(harness.db, ada);
  script = { events: answered, everyMs: 1 };
  lastSignal = null;

  tasks = new TaskRegistry(silent);
  streams = new StreamMultiplexer(redis, tasks, silent);
  stream = new GenerationStream(redis, streams);
  stops = new RedisGenerationStops(redis);
  supervisor = new GenerationSupervisor(
    new RunGenerationUseCase(runner, store, stream),
    stops,
    tasks,
  );
  subscriber = new GenerationSubscriber(store, supervisor, silent);
  watch = new WatchGenerationUseCase(store, stream);
  stopping = new StopGenerationUseCase(store, stops);
  janitor = new EndAbandonedGenerationsUseCase(store, stream);
});

afterEach(async () => {
  await tasks.drain(500);
  await streams.onModuleDestroy();
  await stops.onModuleDestroy();
});

/**
 * The two rows `StartGenerationUseCase` writes, then the event it puts in the
 * outbox. Written here rather than through that command: it belongs to the
 * conversation context, and one context reaching into another's use case is the
 * coupling the boundary rules exist to prevent. That it writes both rows and the
 * event in one transaction is proven where it lives.
 */
async function ask(): Promise<MessageId> {
  await harness.db.insert(messages).values({
    conversationId: room,
    clientMessageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text: "What was Apple's revenue in 2024?" }],
    status: 'complete',
    seq: 1,
  });
  const [placeholder] = await harness.db
    .insert(messages)
    .values({
      conversationId: room,
      role: 'assistant',
      parts: [],
      status: 'generating',
      seq: 2,
    })
    .returning({ id: messages.id });
  if (placeholder === undefined) throw new Error('the placeholder was not written');

  const id = MessageId.trusted(placeholder.id);
  await deliver(id);

  return id;
}

async function deliver(assistantMessageId: MessageId): Promise<void> {
  await subscriber.handle({
    id: '1',
    aggregate: 'message',
    aggregateId: assistantMessageId,
    type: 'generation.requested',
    payload: {},
  });
}

/** Reads the stream the way a connection does, ending when it does or when told. */
async function readStream(
  id: MessageId,
  afterId = STREAM_START,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<StoredStreamEvent[]> {
  const leaving = new AbortController();
  const watching = await watch.execute({ userId: ada }, id, {
    afterId,
    signal: leaving.signal,
  });
  if (!watching.ok) throw watching.error;

  const seen: StoredStreamEvent[] = [];
  for await (const stored of watching.value) {
    seen.push(stored);
    if (seen.length >= stopAfter) break;
  }
  leaving.abort();

  return seen;
}

const typesOf = (seen: readonly StoredStreamEvent[]): readonly string[] =>
  seen.map((stored) => stored.event.type);

const rowFor = async (id: MessageId) =>
  (await harness.db.select().from(messages).where(eq(messages.id, id)))[0];

describe('a question asked and answered', () => {
  it('reaches a runner through the outbox and ends as a verified message', async () => {
    const id = await ask();

    const seen = await readStream(id);

    expect(typesOf(seen)).toEqual([
      'generation_started',
      'tool_call_ready',
      'text_delta',
      'text_delta',
      'verification',
      'message_complete',
    ]);
    const row = await rowFor(id);
    expect(row?.status).toBe('complete');
    // The pairing the database itself insists on: a complete assistant message
    // always carries a report.
    expect(row?.verification).toEqual(REPORT);
    expect(row?.model).toBe('a-model');
  });

  it('is still there to be read after it has finished', async () => {
    const id = await ask();
    await readStream(id);

    // Attaching to a generation that is over replays all of it and ends, which
    // is what makes a refresh mid-answer work without a special path.
    expect(typesOf(await readStream(id))).toContain('message_complete');
  });

  it('does not start a second time when the same event is delivered again', async () => {
    script = { events: answered, everyMs: 20 };
    const id = await ask();

    await deliver(id);
    await delay(300);

    // Two runners on one message would write two answers into it a token at a
    // time. Both the running set and the row's status say no.
    const seen = await readStream(id);
    expect(typesOf(seen).filter((type) => type === 'generation_started')).toHaveLength(1);
  });
});

describe('the same outbox event delivered twice', () => {
  it('is refused by the row once the first run has finished', async () => {
    const id = await ask();
    await delay(100);
    expect((await rowFor(id))?.status).toBe('complete');

    // The in-process set has long forgotten it, so the only thing left saying no
    // is the row itself — which is the guard that works across pods.
    const written = await admin.xlen(K.streamBuffer(id));
    await deliver(id);
    await delay(100);

    // Read past the terminal event, which is where an ordinary reader stops: a
    // second run would append a whole second answer behind it, and every client
    // that reconnected afterwards would replay both.
    expect(await admin.xlen(K.streamBuffer(id))).toBe(written);
  });
});

describe('two writers for one ending', () => {
  it('lets the first decide, and tells the second that it lost', async () => {
    const id = await ask();
    await delay(100);
    const finished = await rowFor(id);

    // The janitor deciding this row was abandoned, a moment after the runner
    // stored a verified answer into it. Without the condition on the write it
    // would replace a complete message with an empty stopped one.
    const second = await store.finish({
      messageId: id,
      status: 'stopped',
      parts: [],
      verification: null,
      model: '',
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(second).toBeNull();
    expect(await rowFor(id)).toEqual(finished);
  });
});

describe('a reader that goes away in the middle', () => {
  it('picks up exactly where it left off, with nothing repeated and nothing lost', async () => {
    script = { events: answered, everyMs: 30 };
    const id = await ask();

    // Attach, take three events, drop the connection — the generation carries on
    // without a reader, which is the whole point of writing it to Redis.
    const first = await readStream(id, STREAM_START, 3);
    await delay(200);
    const resumed = await readStream(id, first.at(-1)?.id ?? STREAM_START);

    expect(typesOf([...first, ...resumed])).toEqual([
      'generation_started',
      'tool_call_ready',
      'text_delta',
      'text_delta',
      'verification',
      'message_complete',
    ]);
  });

  it('does not stop the generation by disconnecting', async () => {
    script = { events: answered, everyMs: 30 };
    const id = await ask();

    await readStream(id, STREAM_START, 2);
    await delay(300);

    // Disconnect is not stop. The row is finished and verified even though
    // nobody was watching when it got there.
    expect((await rowFor(id))?.status).toBe('complete');
  });
});

describe('a generation somebody asks to stop', () => {
  it('is reached over Redis and stored as stopped, keeping what it had written', async () => {
    script = { events: answered, everyMs: 40 };
    const id = await ask();
    await delay(100);

    const asked = await stopping.execute({ userId: ada }, id);
    await delay(200);

    expect(asked.ok).toBe(true);
    // The signal that reached the runner came from a publish, not from a
    // function call: the request and the generation are not the same process.
    expect(lastSignal?.aborted).toBe(true);
    const row = await rowFor(id);
    expect(row?.status).toBe('stopped');
    expect(row?.verification).toBeNull();
  });
});

describe('a process being shut down while it is generating', () => {
  it('cancels the work and still stores an ending for it', async () => {
    script = { events: answered, everyMs: 40 };
    const id = await ask();
    await delay(60);

    // What `TaskRegistry` does on SIGTERM once its patience runs out: cancel,
    // then wait. The generation has to notice, keep what it has and settle —
    // a row left `generating` would block the conversation for good.
    await tasks.drain(10);

    const row = await rowFor(id);
    expect(row?.status).toBe('stopped');
    expect(typesOf(await readStream(id))).toContain('message_complete');
  });
});

describe('a generation nothing is writing any more', () => {
  it('is ended by the sweep rather than blocking the conversation for ever', async () => {
    script = { events: [], everyMs: 1 };
    const id = await ask();
    await delay(50);
    // The row is left `generating` with nothing on its stream, which is what a
    // pod killed mid-answer leaves behind.
    await harness.db.update(messages).set({ status: 'generating' }).where(eq(messages.id, id));

    const ended = await janitor.execute(new Date(Date.now() + 300_000));

    expect(ended).toEqual([id]);
    expect((await rowFor(id))?.status).toBe('stopped');
    // And the conversation is usable again: G1 only counts `generating` rows.
    expect(typesOf(await readStream(id))).toContain('message_complete');
  });
});
