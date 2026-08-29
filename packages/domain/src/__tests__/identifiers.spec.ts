import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors';
import {
  ClientMessageId,
  ConversationId,
  GenerationId,
  MessageId,
  ReservationId,
  UserId,
  type IdentifierCodec,
} from '../identifiers';
import { isErr, isOk } from '../result';

const CODECS: readonly [string, IdentifierCodec<string>][] = [
  ['UserId', UserId],
  ['ConversationId', ConversationId],
  ['MessageId', MessageId],
  ['GenerationId', GenerationId],
  ['ReservationId', ReservationId],
  ['ClientMessageId', ClientMessageId],
];

const V4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const V7 = '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d';

describe.each(CODECS)('%s', (label, codec) => {
  it('accepts a canonical uuid', () => {
    const result = codec.parse(V4);
    expect(isOk(result) && result.value).toBe(V4);
  });

  it('accepts a version 7 uuid, which is what the database generates', () => {
    expect(codec.is(V7)).toBe(true);
  });

  it('normalises to lowercase so the same id never appears twice', () => {
    const upper = codec.parse(V4.toUpperCase());
    expect(isOk(upper) && upper.value).toBe(V4);
  });

  it.each([
    ['empty', ''],
    ['too short', '3f2504e0-4f89-41d3-9a0c'],
    ['no dashes', V4.replaceAll('-', '')],
    ['trailing space', `${V4} `],
    ['nil uuid, version nibble 0', '00000000-0000-0000-0000-000000000000'],
    ['bad variant nibble', '3f2504e0-4f89-41d3-1a0c-0305e82c3301'],
    ['sql injection attempt', "3f2504e0-4f89-41d3-9a0c-0305e82c3301'; DROP TABLE users --"],
  ])('rejects a malformed value (%s)', (_name, raw) => {
    const result = codec.parse(raw);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.message).toBe(`Malformed ${label}.`);
    // The rejected value never reaches a log line; only its shape does.
    expect(result.error.details).toEqual({ expected: 'uuid', length: raw.length });
  });

  it('trusts a value from our own storage without re-parsing', () => {
    expect(codec.trusted(V4.toUpperCase())).toBe(V4);
  });
});

describe('branding', () => {
  it('keeps two ids of different types apart at compile time', () => {
    const conversationId = ConversationId.trusted(V4);
    const messageId = MessageId.trusted(V4);

    // @ts-expect-error same string at runtime, different type. Removing the brand
    // makes this line compile, which fails the build.
    const wrong: MessageId = conversationId;

    expect(wrong).toBe(messageId);
  });
});
