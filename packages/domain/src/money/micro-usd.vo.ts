/**
 * Money is an integer count of micro-USD (1 USD = 1,000,000 micro) in a `bigint`.
 * No float touches the budget path: `0.1 + 0.2 !== 0.3`, and a budget that drifts
 * by a rounding error either overcharges or wrongly refuses, invisibly until a
 * ledger is reconciled.
 */

const MICRO_PER_USD = 1_000_000n;

export type Rounding = 'up' | 'down';

export class MicroUsd {
  static readonly ZERO = new MicroUsd(0n);

  private constructor(readonly micro: bigint) {}

  static fromMicro(micro: bigint): MicroUsd {
    return new MicroUsd(micro);
  }

  /** Configuration and test literals only; a non-finite input is a caller bug, so it throws. */
  static fromUsd(usd: number): MicroUsd {
    if (!Number.isFinite(usd)) {
      throw new TypeError(`MicroUsd.fromUsd requires a finite number, received ${String(usd)}.`);
    }
    return new MicroUsd(BigInt(Math.round(usd * Number(MICRO_PER_USD))));
  }

  /** The canonical wire and database form: a base-10 micro-USD string. */
  static fromMicroString(raw: string): MicroUsd {
    if (!/^-?\d+$/.test(raw)) {
      throw new TypeError(`MicroUsd expects an integer micro-USD string, received "${raw}".`);
    }
    return new MicroUsd(BigInt(raw));
  }

  static sum(amounts: readonly MicroUsd[]): MicroUsd {
    return amounts.reduce<MicroUsd>((total, amount) => total.plus(amount), MicroUsd.ZERO);
  }

  plus(other: MicroUsd): MicroUsd {
    return new MicroUsd(this.micro + other.micro);
  }

  minus(other: MicroUsd): MicroUsd {
    return new MicroUsd(this.micro - other.micro);
  }

  times(factor: bigint): MicroUsd {
    return new MicroUsd(this.micro * factor);
  }

  /**
   * `up` is ceiling and `down` is floor, negatives included. BigInt division
   * truncates towards zero — already the ceiling of a negative quotient and the
   * floor of a positive one — so each direction corrects only the other half.
   * Charging rounds up: one micro lost per request is how a budget stops being one.
   */
  dividedBy(divisor: bigint, rounding: Rounding): MicroUsd {
    if (divisor === 0n) throw new RangeError('MicroUsd.dividedBy received a zero divisor.');

    const quotient = this.micro / divisor;
    const remainder = this.micro % divisor;
    if (remainder === 0n) return new MicroUsd(quotient);

    const isNegativeResult = this.micro < 0n !== divisor < 0n;
    if (rounding === 'up') return new MicroUsd(isNegativeResult ? quotient : quotient + 1n);
    return new MicroUsd(isNegativeResult ? quotient - 1n : quotient);
  }

  compare(other: MicroUsd): -1 | 0 | 1 {
    if (this.micro < other.micro) return -1;
    return this.micro > other.micro ? 1 : 0;
  }

  equals(other: MicroUsd): boolean {
    return this.micro === other.micro;
  }

  isGreaterThan(other: MicroUsd): boolean {
    return this.micro > other.micro;
  }

  isLessThan(other: MicroUsd): boolean {
    return this.micro < other.micro;
  }

  get isZero(): boolean {
    return this.micro === 0n;
  }

  get isNegative(): boolean {
    return this.micro < 0n;
  }

  /** Lossy above 2^53 micro-USD. Display only — never feed this back into a sum. */
  toUsdNumber(): number {
    return Number(this.micro) / Number(MICRO_PER_USD);
  }

  toString(): string {
    return this.micro.toString();
  }

  /** `JSON.stringify` throws on a bigint; the canonical string crosses the wire exact. */
  toJSON(): string {
    return this.micro.toString();
  }
}
