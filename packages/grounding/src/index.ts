/** The public surface. A deep import couples the caller to a file layout free to change. */

export { extractNumericClaims, type Context, type NumericLiteral, type Role } from './claims';
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
export { numericCells, type Cell, type ToolResult } from './tool-result';
