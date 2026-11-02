-- Legacy unbound proof remains unusable; no binding is inferred or backfilled.
ALTER TABLE password_reset_tokens ADD COLUMN credential_fingerprint text;
