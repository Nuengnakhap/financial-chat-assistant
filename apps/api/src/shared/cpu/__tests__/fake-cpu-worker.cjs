'use strict';

/**
 * Stands in for the real worker so a test can reach the paths the tokenizer
 * never takes: a slow task, and a task that answers with the wrong type.
 * The task name has to match, because that is what `CpuPool` asks for.
 */

module.exports = {
  countTokens: async (request) => {
    if (request.text === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 1;
    }
    return 'not a number';
  },
};
