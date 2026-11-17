-- Mutable customer acknowledgement for an editable draft; not a submitted snapshot.
ALTER TABLE orders ADD COLUMN draft_commercial_baseline jsonb
  CHECK (draft_commercial_baseline IS NULL OR jsonb_typeof(draft_commercial_baseline) = 'array');
