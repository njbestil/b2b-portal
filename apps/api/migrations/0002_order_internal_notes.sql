-- B2B-014: private internal note persistence. Never included in customer DTOs.
CREATE TABLE order_internal_notes (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users (id),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
CREATE INDEX order_internal_notes_company_order_created_idx
  ON order_internal_notes (company_id, order_id, created_at, id);
