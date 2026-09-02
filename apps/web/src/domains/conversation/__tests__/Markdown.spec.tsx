import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../components/Markdown';

/**
 * How an answer reads, and what happens to the parts of it that are still
 * arriving. Every answer is streamed a character at a time, so half of anything
 * — half a table, half a chart, half a word — is a state this has to draw rather
 * than an error it can report.
 */

const chart = (spec: unknown): string => `\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``;

const SPEC = {
  type: 'bar',
  title: 'Revenue in 2023',
  xKey: 'company',
  series: [{ key: 'revenue', label: 'Revenue' }],
  data: [{ company: 'Apple', revenue: 383285000000 }],
};

describe('a table of figures', () => {
  it('is a table, with the columns the model aligned right kept apart', () => {
    render(
      <Markdown text={['| Company | Revenue |', '|---|---:|', '| Apple | $391.0B |'].join('\n')} />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    // A figure column is tabular so a value never changes width as it changes.
    expect(screen.getByRole('cell', { name: '$391.0B' })).toHaveClass('fin-num');
    expect(screen.getByRole('cell', { name: 'Apple' })).not.toHaveClass('fin-num');
  });
});

describe('a chart the model asked for', () => {
  it('is drawn from the block it wrote', () => {
    render(<Markdown text={chart(SPEC)} />);

    expect(screen.getByRole('img', { name: /Revenue in 2023/ })).toBeInTheDocument();
  });

  it('is drawn from a block the model wrote over several lines', () => {
    // Which is how it actually arrives: the model pretty-prints the JSON, so the
    // fenced content reaches the renderer as several pieces rather than one.
    render(<Markdown text={`\`\`\`chart\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``} />);

    expect(screen.getByRole('img', { name: /Revenue in 2023/ })).toBeInTheDocument();
  });

  it('stays a block of text while it is still arriving', () => {
    // The JSON is streamed like everything else, so most of the time it has
    // been seen it was not yet valid.
    render(<Markdown text={'```chart\n{"type":"bar","tit'} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/"type":"bar"/)).toBeInTheDocument();
  });

  it('stays a block of text when it is not a chart this can draw', () => {
    // Never a crash and never an invented shape: a picture drawn from numbers
    // nobody sent is the one thing this application must not produce.
    render(
      <Markdown text={chart({ type: 'pie', title: 'Share', xKey: 'x', series: [], data: [] })} />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/"type":"pie"/)).toBeInTheDocument();
  });
});

describe('an ordinary fenced block', () => {
  it('is code rather than a chart', () => {
    render(<Markdown text={'```sql\nSELECT 1\n```'} />);

    expect(screen.getByText('SELECT 1')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('the rest of an answer', () => {
  it('draws the shapes a model writes in, and nothing else', () => {
    render(
      <Markdown
        text={[
          '## Revenue',
          '',
          'Apple earned **$391.0B**, which is `revenue` for 2024.',
          '',
          '- Apple',
          '- Microsoft',
          '',
          '1. first',
          '',
          '[the filing](https://example.com)',
        ].join('\n')}
      />,
    );

    // Headings are demoted: the one heading on this screen is the page's, and a
    // model writing `##` must not outrank it.
    expect(screen.getByRole('heading', { name: 'Revenue', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('$391.0B')).toBeInTheDocument();
    expect(screen.getByText('revenue')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'the filing' })).toHaveAttribute(
      'rel',
      'noreferrer noopener',
    );
  });
});

describe('a chart of more than one thing', () => {
  it('draws a line chart when the model asked for one', () => {
    render(
      <Markdown
        text={chart({
          ...SPEC,
          type: 'line',
          xKey: 'year',
          series: [
            { key: 'apple', label: 'Apple' },
            { key: 'microsoft', label: 'Microsoft' },
            { key: 'amazon', label: 'Amazon' },
            { key: 'alphabet', label: 'Alphabet' },
            { key: 'nvidia', label: 'NVIDIA' },
          ],
          data: [{ year: '2024', apple: 1, microsoft: 2, amazon: 3, alphabet: 4, nvidia: 5 }],
        })}
      />,
    );

    // Five series over four colours: the fifth takes the first again rather
    // than being drawn in nothing.
    expect(screen.getByRole('img', { name: /Revenue in 2023/ })).toBeInTheDocument();
  });
});
