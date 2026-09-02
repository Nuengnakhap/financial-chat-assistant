import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import type { TaskRegistry } from '../../../bootstrap/task-registry';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { LlmCapabilityService } from '../llm-capability.service';
import type { Capabilities, LlmGateway } from '../ports/llm-gateway.port';

/**
 * The point of this service is that somebody finds out about a misconfigured
 * endpoint from a log line rather than from a user's first question, so what is
 * tested is the log line.
 */

interface FakeGateway {
  readonly gateway: LlmGateway;
  answer: Capabilities | Error;
  checks: number;
}

function fakeGateway(): FakeGateway {
  const fake: FakeGateway = {
    answer: { usable: true, missing: [] },
    checks: 0,
    gateway: {
      streamCompletion: () => {
        throw new Error('not used here');
      },
      checkCapabilities: async (): Promise<Capabilities> => {
        fake.checks += 1;
        if (fake.answer instanceof Error) throw fake.answer;
        return await Promise.resolve(fake.answer);
      },
    },
  };

  return fake;
}

function capturing(): { readonly logger: AppLogger; text: () => string } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });

  return {
    logger: new AppLogger(createPinoLogger({ level: 'debug', pretty: false, destination })),
    text: () => written.join(''),
  };
}

let fake: FakeGateway;
let capture: ReturnType<typeof capturing>;
let service: LlmCapabilityService;
const signal = new AbortController().signal;

beforeEach(() => {
  fake = fakeGateway();
  capture = capturing();
  service = new LlmCapabilityService(fake.gateway, {} as TaskRegistry, capture.logger);
});

describe('the capability check', () => {
  it('knows nothing until it has asked', async () => {
    expect(service.current()).toBeNull();

    await service.measure(signal);

    expect(service.current()).toEqual({ usable: true, missing: [] });
  });

  it('says every reason, because each one is a different thing to fix', async () => {
    fake.answer = {
      usable: false,
      missing: ['the endpoint returned no streamed chunks', 'the endpoint did not call the tool'],
    };

    await service.measure(signal);

    expect(capture.text()).toContain('no streamed chunks');
    expect(capture.text()).toContain('did not call the tool');
    expect(capture.text()).toContain('"level":50');
  });

  it('says it once rather than every five minutes', async () => {
    fake.answer = { usable: false, missing: ['the endpoint is not there'] };
    await service.measure(signal);
    const said = capture.text().length;

    await service.measure(signal);

    expect(capture.text().length).toBe(said);
  });

  it('says so again when a broken endpoint starts working', async () => {
    fake.answer = { usable: false, missing: ['the endpoint is not there'] };
    await service.measure(signal);
    fake.answer = { usable: true, missing: [] };

    await service.measure(signal);

    expect(capture.text()).toContain('the model endpoint is usable');
    expect(service.current()?.usable).toBe(true);
  });

  it('survives a gateway that throws instead of answering', async () => {
    // The port says a verdict comes back rather than an exception, and today's
    // adapter honours that. A throw would otherwise end the loop, and the one
    // thing this service does is keep asking.
    fake.answer = new Error('the client library gave up');

    await service.measure(signal);

    expect(service.current()).toEqual({ usable: false, missing: ['the client library gave up'] });
    expect(capture.text()).toContain('the client library gave up');
  });

  it('keeps asking after a throw, rather than dying quietly', async () => {
    const controller = new AbortController();
    fake.answer = new Error('down');
    const loop = service.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await loop;

    expect(fake.checks).toBeGreaterThan(1);
  });

  it('keeps asking on a schedule, and stops when told to', async () => {
    const controller = new AbortController();
    const loop = service.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await loop;

    expect(fake.checks).toBeGreaterThan(1);
  });
});
