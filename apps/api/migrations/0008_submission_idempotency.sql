-- A reservation is committed with its submitted order and immutable snapshot.
CREATE TABLE submission_idempotency (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  company_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  outbound_reference uuid NOT NULL UNIQUE,
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
