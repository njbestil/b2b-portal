-- Existing confirmations retain identity; unknown historical request keys cannot replay.
ALTER TABLE order_confirmations ADD COLUMN request_fingerprint text
 CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$');
