import { describe, expect, it } from 'vitest';

import { assertNever } from '../assert';

type Shape = { kind: 'circle' } | { kind: 'square' };

describe('assertNever', () => {
  it('names the context and the offending value', () => {
    const rogue = { kind: 'triangle' };

    expect(() => {
      const shape = rogue as unknown as Shape;
      switch (shape.kind) {
        case 'circle':
        case 'square':
          return;
        default:
          return assertNever(shape, 'Shape');
      }
    }).toThrow('Unhandled variant in Shape: {"kind":"triangle"}');
  });

  it('falls back to a safe description when the value cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => assertNever(circular as never, 'Circular')).toThrow(
      'Unhandled variant in Circular: [object Object]',
    );
  });

  it('describes a value that JSON.stringify turns into undefined', () => {
    expect(() => assertNever((() => undefined) as never, 'Fn')).toThrow(/Unhandled variant in Fn:/);
  });
});
