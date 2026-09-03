import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { ChartBlock } from './ChartBlock';

/**
 * An answer as it reads.
 *
 * Markdown with GFM, because tables are how more than one figure is shown and
 * the model is told to write them. The overrides below are the whole styling
 * story: this direction has no prose plugin and no `.markdown` stylesheet, so
 * every element is a decision made once, here, in the same tokens the rest of
 * the interface is built from.
 *
 * Nothing in it can crash the page. A malformed table is drawn as whatever it
 * parses to, and a chart block that will not read stays a code block — an
 * answer arrives a character at a time, so half of everything is a state this
 * has to hold rather than an error.
 */

const CHART = 'language-chart';

/**
 * Prose is held to the reading measure and the figures are not. A sentence that
 * runs the width of the room is tiring to read; a table of four columns held to
 * the width of a sentence scrolls sideways while a third of the screen sits
 * empty beside it. Both were true here, and this is where the two part company.
 */
const PROSE = 'max-w-measure';

const COMPONENTS: Components = {
  p: ({ children }) => <p className={`${PROSE} my-3 first:mt-0 last:mb-0`}>{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className={`${PROSE} my-3 list-disc pl-4`}>{children}</ul>,
  ol: ({ children }) => <ol className={`${PROSE} my-3 list-decimal pl-4`}>{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  h1: ({ children }) => (
    <h3 className={`${PROSE} mt-6 mb-2 text-heading-sm font-book`}>{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className={`${PROSE} mt-6 mb-2 text-heading-sm font-book`}>{children}</h3>
  ),
  h3: ({ children }) => <h4 className={`${PROSE} mt-6 mb-2 font-medium`}>{children}</h4>,
  a: ({ children, href }) => (
    <a className="underline underline-offset-2" href={href} rel="noreferrer noopener">
      {children}
    </a>
  ),
  // Wide tables scroll rather than push the column out: a conversation has a
  // measure, and a table with nine columns must not decide it.
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-line-strong">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-line last:border-0">{children}</tr>,
  th: ({ children, style }) => (
    <th
      /* The alignment is read out of the markdown the model wrote: a value that
         arrives rather than one chosen here. */
      // eslint-disable-next-line local-tokens/no-off-token-styles -- see above
      style={style}
      className="py-2 pr-4 text-left font-mono text-micro tracking-wide text-muted uppercase last:pr-0"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    /* A column the model marked as right-aligned is a column of figures, and
       figures must not change width as they change value. The alignment itself
       comes from the table the model wrote. */
    // eslint-disable-next-line local-tokens/no-off-token-styles -- see above
    <td style={style} className={cellClass(style)}>
      {children}
    </td>
  ),
  code: ({ className, children }) =>
    className === CHART ? (
      <ChartBlock source={textOf(children)} />
    ) : (
      <code className="rounded-sm bg-panel px-1 py-1 font-mono text-caption">{children}</code>
    ),
  // Left as it is: a fenced block is already inside `code` above, and wrapping
  // a chart in a `pre` would put a scrollbar round a picture.
  pre: ({ children }) => <>{children}</>,
};

export function Markdown({ text }: { readonly text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

function cellClass(style: React.CSSProperties | undefined): string {
  const figures = style?.textAlign === 'right';

  return `py-2 pr-4 last:pr-0${figures ? ' fin-num pr-0 pl-4' : ''}`;
}

/**
 * A fenced block's content. There is nothing inside one but text, however many
 * lines it runs to, so anything else is a block this cannot read — which is the
 * same as an empty one, and `ChartBlock` shows it as it was written.
 */
function textOf(children: ReactNode): string {
  return typeof children === 'string' ? children : '';
}
