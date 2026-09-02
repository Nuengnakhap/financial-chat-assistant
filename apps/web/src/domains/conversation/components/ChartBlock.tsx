import { chartSpec, type ChartSpec } from '@fca/contracts';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { compactUsd } from '../utils/figures';

/**
 * A chart the answer asked for.
 *
 * It is never the only place a number appears: the model is told to write the
 * table as well, and the table is what the verifier checked. That is what makes
 * a chart safe to draw — it is a second reading of figures that have already
 * been proved, so a chart that fails to render loses nothing but the picture.
 *
 * Which is why nothing here can throw. A block that does not parse stays a code
 * block, and one that arrives half-written — the fenced JSON is streamed a
 * character at a time like everything else — waits rather than flickering
 * between shapes.
 */

/** Tall enough for a trend to have a shape, short enough to sit inside an answer. */
const HEIGHT = 280;

/**
 * Four hues that hold their distance from each other in both themes and stay
 * apart for the commonest colour blindness. Bounded by the schema's six series;
 * past four a legend is a list nobody reads, and the table beside it is better.
 */
const SERIES_COLOURS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
] as const;

export function ChartBlock({ source }: { readonly source: string }) {
  const spec = read(source);
  if (spec === null) return <Unreadable source={source} />;

  return (
    <figure className="my-6">
      <figcaption className="mb-3 font-mono text-micro tracking-wide text-muted uppercase">
        {spec.title}
      </figcaption>
      {/* The picture is decoration over data that is already on the page as a
          table, so it is hidden from a screen reader rather than described
          badly. The label says where the same figures can be read. */}
      <div
        /* A chart has to be given a height to draw into, and there is no scale
           for one: the spacing rhythm is for gaps between things and the measure
           scale is for how long a line of prose gets. */
        // eslint-disable-next-line local-tokens/no-off-token-styles -- see above
        style={{ height: HEIGHT }}
        role="img"
        aria-label={`${spec.title}. The same figures are in the table beside this chart.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === 'bar' ? <Bars spec={spec} /> : <Lines spec={spec} />}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function Bars({ spec }: { readonly spec: ChartSpec }) {
  return (
    <BarChart data={[...spec.data]} margin={MARGIN}>
      {axes(spec)}
      {spec.series.map((series, index) => (
        <Bar key={series.key} dataKey={series.key} name={series.label} fill={colourAt(index)} />
      ))}
    </BarChart>
  );
}

function Lines({ spec }: { readonly spec: ChartSpec }) {
  return (
    <LineChart data={[...spec.data]} margin={MARGIN}>
      {axes(spec)}
      {spec.series.map((series, index) => (
        <Line
          key={series.key}
          type="monotone"
          dataKey={series.key}
          name={series.label}
          stroke={colourAt(index)}
          strokeWidth={2}
          dot={false}
        />
      ))}
    </LineChart>
  );
}

const MARGIN = { top: 4, right: 8, bottom: 0, left: 8 };

const AXIS = { stroke: 'var(--color-muted)', fontSize: 11 };

/**
 * Returned as an array rather than a component: Recharts reads its children to
 * find the axes, and a wrapper around them is a child it does not recognise.
 */
function axes(spec: ChartSpec) {
  return [
    <CartesianGrid key="grid" stroke="var(--color-line)" vertical={false} />,
    <XAxis key="x" dataKey={spec.xKey} tickLine={false} axisLine={false} tick={AXIS} />,
    <YAxis key="y" tickFormatter={compactUsd} tickLine={false} axisLine={false} tick={AXIS} />,
    <Tooltip
      key="tip"
      formatter={(value: unknown) => compactUsd(value)}
      contentStyle={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-line)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-caption)',
      }}
    />,
    <Legend key="legend" height={24} iconType="plainline" />,
  ];
}

/** Wraps rather than running out: the schema allows six series and there are four. */
function colourAt(index: number): string {
  const [first] = SERIES_COLOURS;

  return SERIES_COLOURS[index % SERIES_COLOURS.length] ?? first;
}

/**
 * The block as it was written. A chart that will not parse is either still
 * arriving or wrong, and showing the JSON is honest about both — inventing a
 * shape for it would be drawing numbers nobody sent.
 */
function Unreadable({ source }: { readonly source: string }) {
  return (
    <pre className="my-4 overflow-x-auto rounded-md border border-line bg-panel p-3 font-mono text-caption text-muted">
      {source}
    </pre>
  );
}

function read(source: string): ChartSpec | null {
  try {
    const parsed = chartSpec.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : null;
  } catch {
    // Half of it, most likely: the JSON is streamed a character at a time like
    // the rest of the answer.
    return null;
  }
}
