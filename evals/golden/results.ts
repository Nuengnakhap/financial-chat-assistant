import type { ToolResult } from '@fca/grounding';

/**
 * Query results recorded from the real table, so the suite runs without a
 * database and still argues about real figures.
 *
 * Every trap the dataset is known for is in here on purpose: values that are
 * negative and small, a company whose recorded revenue is a quarter of what the
 * world believes, columns that are `NULL` rather than zero, averages that come
 * back with eight decimals, three companies whose figures share one display
 * string, and a value that lands exactly on a rounding boundary.
 */

/** Apple, four years of net income. Ordinary, and the baseline for everything else. */
export const appleNetIncome: ToolResult = {
  toolCallId: 'q_apple_net_income',
  columns: ['company', 'year', 'net_income'],
  rows: [
    ['Apple', '2022', '99803000000'],
    ['Apple', '2023', '96995000000'],
    ['Apple', '2024', '93736000000'],
    ['Apple', '2025', '112010000000'],
  ],
};

/** Two companies, two years — the shape a comparison answer is built from. */
export const appleVsMicrosoft: ToolResult = {
  toolCallId: 'q_apple_vs_microsoft',
  columns: ['company', 'year', 'revenue'],
  rows: [
    ['Apple', '2022', '394328000000'],
    ['Microsoft', '2022', '198270000000'],
    ['Apple', '2023', '383285000000'],
    ['Microsoft', '2023', '211915000000'],
  ],
};

/** Losses. Two of these are negative, and one of them is small enough to change scale. */
export const intelNetIncome: ToolResult = {
  toolCallId: 'q_intel_net_income',
  columns: ['year', 'net_income'],
  rows: [
    ['2022', '8014000000'],
    ['2023', '1689000000'],
    ['2024', '-18756000000'],
    ['2025', '-267000000'],
  ],
};

/** The smallest magnitude in the table, and negative: −22M reads in millions. */
export const abbvieNetIncome: ToolResult = {
  toolCallId: 'q_abbvie_net_income',
  columns: ['year', 'net_income'],
  rows: [
    ['2024', '-22000000'],
    ['2025', '1816000000'],
  ],
};

/**
 * The litmus test. Recorded revenue is 21.4B where the world outside believes
 * about 85B, so an answer near 85B is a model reciting what it already knew.
 */
export const johnsonRevenue: ToolResult = {
  toolCallId: 'q_johnson_revenue',
  columns: ['company', 'year', 'revenue'],
  rows: [['JohnsonJohnson', '2023', '21395000000']],
};

/** Two points three years apart — everything a growth rate could be derived from. */
export const nvidiaRevenue: ToolResult = {
  toolCallId: 'q_nvidia_revenue',
  columns: ['year', 'revenue'],
  rows: [
    ['2022', '26914000000'],
    ['2025', '130497000000'],
  ],
};

/** A ranking, which is where a table grows a leading column of positions. */
export const topRevenue2024: ToolResult = {
  toolCallId: 'q_top_revenue_2024',
  columns: ['company', 'revenue'],
  rows: [
    ['Walmart', '642637000000'],
    ['Amazon', '637959000000'],
    ['UnitedHealth', '400278000000'],
    ['Apple', '391035000000'],
    ['Google', '350018000000'],
  ],
};

/** Recorded, and not recorded. Goldman's revenue is `NULL` in every year. */
export const goldmanRevenue: ToolResult = {
  toolCallId: 'q_goldman_revenue',
  columns: ['company', 'year', 'revenue'],
  rows: [['Goldman', '2023', null]],
};

/** Mastercard has no net income recorded, in any year. */
export const mastercardNetIncome: ToolResult = {
  toolCallId: 'q_mastercard_net_income',
  columns: ['company', 'year', 'net_income'],
  rows: [['Mastercard', '2024', null]],
};

/** `avg()` over a `bigint` column comes back as `numeric`, decimals and all. */
export const sectorAverages: ToolResult = {
  toolCallId: 'q_sector_averages',
  columns: ['sector', 'average_revenue'],
  rows: [
    ['Consumer', '157282577777.77777778'],
    ['Energy', '271499500000.00000000'],
    ['Finance', '51802545454.54545455'],
    ['Healthcare', '99999337500.00000000'],
    ['Technology', '148487664400.00000000'],
  ],
};

/** Three companies whose figures all print as `$10.6B`. */
export const crowdedDisplay: ToolResult = {
  toolCallId: 'q_crowded_display',
  columns: ['company', 'value'],
  rows: [
    ['AMD', '10603000000'],
    ['Coca-Cola', '10631000000'],
    ['Eli Lilly', '10590000000'],
  ],
};

/** Exactly on a rounding boundary: 17.45B is the edge of both `$17.4B` and `$17.5B`. */
export const teslaGrossProfit: ToolResult = {
  toolCallId: 'q_tesla_gross_profit',
  columns: ['company', 'year', 'gross_profit'],
  rows: [['Tesla', '2024', '17450000000']],
};

/** Two of the forty-nine companies do not have all four years. */
export const blackrockYears: ToolResult = {
  toolCallId: 'q_blackrock_years',
  columns: ['company', 'year', 'revenue'],
  rows: [['BlackRock', '2023', '17859000000']],
};

export const shopifyYears: ToolResult = {
  toolCallId: 'q_shopify_years',
  columns: ['company', 'year', 'revenue'],
  rows: [['Shopify', '2024', '8880000000']],
};

/** A query that ran and found nothing. Not the same as never having asked. */
export const emptyResult: ToolResult = {
  toolCallId: 'q_empty',
  columns: ['company', 'year', 'revenue'],
  rows: [],
};

/** Every recorded result, for the cases that are generated rather than written out. */
export const RECORDED: readonly ToolResult[] = [
  appleNetIncome,
  appleVsMicrosoft,
  intelNetIncome,
  abbvieNetIncome,
  johnsonRevenue,
  nvidiaRevenue,
  topRevenue2024,
  sectorAverages,
  crowdedDisplay,
  teslaGrossProfit,
  blackrockYears,
  shopifyYears,
];
