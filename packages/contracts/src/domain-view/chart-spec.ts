import { z } from 'zod';

/**
 * A chart the model asked for, inside the answer.
 *
 * The model writes it as a fenced block marked `chart`, holding this shape and
 * nothing else. It is defined here rather than in either side because both read
 * it: the prompt tells the model what to write out of `CHART_BLOCK_SHAPE`, and
 * the browser parses what arrives with `chartSpec` — one definition, so the
 * instruction and the reader cannot drift apart.
 *
 * The values are the raw numbers from the tool result, never formatted strings.
 * A chart is drawn from the same figures the verifier checked; formatting them
 * on the way in would put a number on screen that no evidence matches.
 */

const cell = z.union([z.string(), z.number(), z.null()]);

export const chartSpec = z.object({
  type: z.enum(['bar', 'line']),
  title: z.string().min(1).max(120),
  /** The column along the bottom — a company, or a year. */
  xKey: z.string().min(1),
  /** At most six: past that a legend is a list nobody reads. */
  series: z
    .array(z.object({ key: z.string().min(1), label: z.string().min(1) }))
    .min(1)
    .max(6),
  /** Bounded by what the query policy will return in the first place. */
  data: z.array(z.record(z.string(), cell)).min(1).max(50),
});

export type ChartSpec = z.infer<typeof chartSpec>;

/**
 * What the prompt tells the model to write. Kept beside the schema so that
 * changing one without the other is a change to one line of the same file.
 */
export const CHART_BLOCK_SHAPE =
  '{"type":"bar"|"line","title","xKey","series":[{"key","label"}],"data":[...]}';
