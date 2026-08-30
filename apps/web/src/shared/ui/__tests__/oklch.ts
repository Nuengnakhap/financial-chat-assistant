/**
 * OKLCH to WCAG contrast, with no dependency. Test-only: nothing in the product
 * computes colours at runtime, and a library for forty lines of published matrix
 * arithmetic would be a supply-chain decision taken for convenience.
 *
 * `contrast.spec.ts` proves the arithmetic before trusting it, by checking the
 * two values everyone knows: white against black is 21:1, and a colour against
 * itself is 1:1.
 */

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** Parses `oklch(0.55 0.1 190)`. Percentages and `none` are not used here. */
export function parseOklch(value: string): Oklch {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  const [l, c, h] = parts;
  if (parts.length !== 3 || l === undefined || c === undefined || h === undefined) {
    throw new Error(`not an oklch triple: ${value}`);
  }
  if ([l, c, h].some(Number.isNaN)) throw new Error(`oklch has a non-number: ${value}`);
  return { l, c, h };
}

/** Linear-light sRGB, clamped into gamut. Out-of-gamut is what a display does anyway. */
function toLinearRgb({ l, c, h }: Oklch): readonly [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
  return [
    clamp(4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube),
    clamp(-1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube),
    clamp(-0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube),
  ];
}

/** WCAG 2.x relative luminance, which is defined on linear-light sRGB. */
function relativeLuminance(colour: Oklch): number {
  const [r, g, b] = toLinearRgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
