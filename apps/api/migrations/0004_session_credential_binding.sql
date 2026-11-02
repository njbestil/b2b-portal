-- B2B-016. Version 0003 is reserved by parallel customer application work.
-- Legacy/unrecognized bindings never become authenticated through backfill.
ALTER TABLE user_sessions ADD COLUMN credential_fingerprint text;
