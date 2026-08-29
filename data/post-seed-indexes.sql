-- Indexes for financial_data. The dump ships data only, no indexes.
-- Every generated query filters on a company identifier and/or year, so these three
-- cover the access patterns the model can produce.

CREATE INDEX IF NOT EXISTS idx_financial_data_ticker_year ON financial_data (ticker, year);
CREATE INDEX IF NOT EXISTS idx_financial_data_company_year ON financial_data (company, year);
CREATE INDEX IF NOT EXISTS idx_financial_data_sector_year ON financial_data (sector, year);

ANALYZE financial_data;
