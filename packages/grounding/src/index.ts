/** The public surface. A deep import couples the caller to a file layout free to change. */

export {
  NUMERIC_LITERAL,
  bandOf,
  contains,
  formatUsd,
  readNumeric,
  valueOf,
  type Band,
  type Reading,
} from './display';
export { buildEvidenceSet, type EvidenceSet, type Origin, type Support } from './evidence';
export { numericCells, type Cell, type ToolResult } from './tool-result';
export {
  add,
  compare,
  divide,
  exact,
  isInteger,
  isNegative,
  multiply,
  negate,
  ratio,
  roundToInteger,
  subtract,
  toApproximateNumber,
  type Quantity,
} from './quantity';
