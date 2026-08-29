import 'reflect-metadata';

import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

/**
 * NestJS resolves a constructor dependency by reading the `design:paramtypes`
 * metadata the compiler emits next to the class. Vitest does not run `tsc`, so
 * whether that metadata survives depends entirely on the transform configured
 * for this project — and the default one does not even parse a decorator.
 *
 * These tests exist so that a transform change breaks here, with a legible
 * message, instead of surfacing later as "Nest can't resolve dependencies of
 * X (?)" in an unrelated feature.
 */

const CLOCK = Symbol('Clock');

interface Clock {
  now(): Date;
}

@Injectable()
class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-08-29T00:00:00.000Z');
  }
}

@Injectable()
class Greeter {
  // A parameter property, resolved by type — the exact shape every service uses.
  constructor(private readonly clock: FixedClock) {}

  greet(): string {
    return `hello at ${this.clock.now().toISOString()}`;
  }
}

@Injectable()
class TokenConsumer {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  year(): number {
    return this.clock.now().getUTCFullYear();
  }
}

describe('the transform used for this project', () => {
  it('keeps constructor parameter types as runtime metadata', () => {
    const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', Greeter);

    expect(paramTypes).toEqual([FixedClock]);
  });

  it('emits nothing at all for a class with no constructor', () => {
    // Not an empty list — nothing. Nest reads the absence as "no dependencies",
    // which the injection tests below confirm end to end.
    expect(Reflect.getMetadata('design:paramtypes', FixedClock)).toBeUndefined();
  });
});

describe('NestJS dependency injection', () => {
  it('resolves a dependency by its type', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Greeter, FixedClock],
    }).compile();

    expect(moduleRef.get(Greeter).greet()).toBe('hello at 2026-08-29T00:00:00.000Z');
  });

  it('resolves a dependency by an injection token, which is how ports are bound', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TokenConsumer, { provide: CLOCK, useClass: FixedClock }],
    }).compile();

    expect(moduleRef.get(TokenConsumer).year()).toBe(2026);
  });

  it('substitutes a port with a stub, without booting anything real', async () => {
    const stub: Clock = { now: () => new Date('1999-12-31T00:00:00.000Z') };

    const moduleRef = await Test.createTestingModule({
      providers: [TokenConsumer, { provide: CLOCK, useValue: stub }],
    }).compile();

    expect(moduleRef.get(TokenConsumer).year()).toBe(1999);
  });
});
