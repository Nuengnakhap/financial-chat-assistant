/** @type {import('prettier').Config} */
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: ['*.md'],
      options: { proseWrap: 'preserve' },
    },
    {
      // Double quotes are the convention across YAML tooling.
      files: ['*.yml', '*.yaml'],
      options: { proseWrap: 'preserve', singleQuote: false },
    },
  ],
};
