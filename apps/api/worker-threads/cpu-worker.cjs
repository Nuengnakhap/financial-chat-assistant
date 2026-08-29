'use strict';

/**
 * Runs on a worker thread. Loaded by filename rather than imported, so it is
 * plain CommonJS with nothing to build — the path has to resolve identically
 * from `src` during a test run and from `dist` when the API runs.
 */

// Named rather than taken from the package default, which is free to change.
// o200k_base is what the current OpenAI models use; a different provider will
// tokenize differently, and that is tolerable because this number only sizes
// the budget reservation — settlement uses the usage the provider reports.
const { countTokens } = require('gpt-tokenizer/encoding/o200k_base');

module.exports = {
  /** @param {{ text: string }} request */
  countTokens: (request) => countTokens(request.text),
};
