-- Globally unique customer keys bind one actor, order and cancellation request.
CREATE TABLE cancellation_idempotency (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  request_id uuid NOT NULL UNIQUE REFERENCES order_cancellation_requests (id),
  reason_hash text NOT NULL CHECK (reason_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
