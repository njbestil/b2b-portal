-- #38: retained submitted snapshot, transition identity and truthful event states.
CREATE TABLE application_reviews (
  company_id uuid PRIMARY KEY REFERENCES companies(id),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
