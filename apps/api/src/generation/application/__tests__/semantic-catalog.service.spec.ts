import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import type { TaskRegistry } from '../../../bootstrap/task-registry';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import type { CatalogSource } from '../ports/semantic-catalog.port';
import type { SemanticCatalog } from '../semantic-catalog';
import { SemanticCatalogService } from '../semantic-catalog.service';

/**
 * Holding a catalog is easy; the parts worth testing are what happens when the
 * read fails and what happens when it comes back different.
 */

const CATALOG: SemanticCatalog = {
  companies: [{ company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2024] }],
  columns: [{ name: 'revenue', kind: 'money', recorded: 1 }],
  rows: 1,
  years: [2024],
  fingerprint: 'first',
};

interface FakeSource {
  readonly source: CatalogSource;
  answer: SemanticCatalog | Error;
  builds: number;
}

function fakeSource(): FakeSource {
  const fake: FakeSource = {
    answer: CATALOG,
    builds: 0,
    source: {
      build: async (): Promise<SemanticCatalog> => {
        fake.builds += 1;
        if (fake.answer instanceof Error) throw fake.answer;
        return await Promise.resolve(fake.answer);
      },
    },
  };

  return fake;
}

function capturing(): { readonly logger: AppLogger; lines: () => readonly string[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });

  return {
    logger: new AppLogger(createPinoLogger({ level: 'debug', pretty: false, destination })),
    lines: () =>
      written
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line !== ''),
  };
}

let source: FakeSource;
let capture: ReturnType<typeof capturing>;
let service: SemanticCatalogService;

beforeEach(() => {
  source = fakeSource();
  capture = capturing();
  service = new SemanticCatalogService(source.source, {} as TaskRegistry, capture.logger);
});

describe('the catalog service', () => {
  it('has nothing until the first read', async () => {
    expect(service.current()).toBeNull();

    await service.refresh();

    expect(service.current()).toEqual(CATALOG);
  });

  it('keeps what it had when a later read fails', async () => {
    // An unreachable database for a minute is not a reason to forget what the
    // dataset holds — and answering with a stale catalog beats refusing.
    await service.refresh();
    source.answer = new Error('the server went away');

    await service.refresh();

    expect(service.current()).toEqual(CATALOG);
  });

  it('says so when the dataset itself has changed', async () => {
    // Worth a line, because every prompt prefix from that moment is a new one
    // and the provider's cache of the old one is dead weight.
    await service.refresh();
    source.answer = { ...CATALOG, fingerprint: 'second' };
    await service.refresh();

    expect(capture.lines().join('')).toContain('semantic catalog changed');
  });

  it('says nothing when it has not', async () => {
    await service.refresh();
    const quiet = capture.lines().length;
    await service.refresh();

    expect(capture.lines().length).toBe(quiet);
  });

  it('reads again on a schedule, and stops when told to', async () => {
    const controller = new AbortController();
    const loop = service.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await loop;

    expect(source.builds).toBeGreaterThan(1);
  });
});
