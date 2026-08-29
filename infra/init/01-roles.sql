-- Least-privilege roles. Runs once, on first boot of an empty data volume.
--
-- Three roles, three jobs:
--   app          - owns the schema; used only to run migrations and seeds (created by the image)
--   app_runtime  - DML on application tables, no DDL; the API connects as this role
--   llm_reader   - SELECT on financial_data only; every SQL statement written by the
--                  model executes as this role, so a flaw in the application-level
--                  guard still cannot write, read other tables, or run long queries.

CREATE ROLE app_runtime LOGIN PASSWORD 'runtime_password';
CREATE ROLE llm_reader LOGIN PASSWORD 'llm_reader_password';

GRANT CONNECT ON DATABASE financial_chat TO app_runtime, llm_reader;
GRANT USAGE ON SCHEMA public TO app_runtime, llm_reader;

-- app_runtime gets DML on whatever `app` creates later (migrations), without DDL rights.
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Hard limits for the model-facing role. These hold even if application code is wrong.
ALTER ROLE llm_reader SET default_transaction_read_only = on;
ALTER ROLE llm_reader SET statement_timeout = '3s';
ALTER ROLE llm_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE llm_reader CONNECTION LIMIT 10;

-- llm_reader is granted SELECT on financial_data by data/grant-llm-reader.sql,
-- which must run after every seed because DROP TABLE discards table grants.
