-- Grants for the model-facing role. Must run after every seed: the dump starts with
-- DROP TABLE, which discards table-level grants along with the table.
--
-- REVOKE first so the role can never accumulate access to tables added later.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM llm_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM llm_reader;

GRANT USAGE ON SCHEMA public TO llm_reader;
GRANT SELECT ON financial_data TO llm_reader;
