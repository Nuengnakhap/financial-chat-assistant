/**
 * The questions the empty screen offers.
 *
 * They are examples of what this dataset can answer, not of what a language
 * model can say: each one names a company and years the data holds, so somebody
 * who takes the invitation gets an answer rather than a polite refusal on their
 * first try.
 *
 * Which company each one is about is written down beside it rather than left to
 * be read out of the sentence, because that is what a test can check against
 * the data — the alternative is copy that promises an answer and a dataset that
 * quietly stopped holding one.
 */
export interface Example {
  readonly question: string;
  /** The companies this question names, if it names any. */
  readonly about: readonly string[];
}

export const EXAMPLES: readonly Example[] = [
  { question: 'What was the revenue of Apple in 2024?', about: ['Apple'] },
  {
    question: 'Compare the net income of Microsoft and Amazon from 2022 to 2025.',
    about: ['Microsoft', 'Amazon'],
  },
  // Every company in the dataset at once, which is a question only the data can
  // answer and the one that shows what the queries are for.
  { question: 'Which three companies had the highest revenue in 2023?', about: [] },
  // `Nvidia`, which is how the dataset spells it. The company name in the
  // question is the one that has to match a row.
  { question: 'How did Nvidia revenue change between 2022 and 2025?', about: ['Nvidia'] },
];
