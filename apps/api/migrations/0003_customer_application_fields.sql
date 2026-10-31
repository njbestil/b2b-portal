-- B2B-024: retain the submitted administrator contact and initial-admin linkage.
-- No account activation, credential provisioning or data reset.
ALTER TABLE users ADD COLUMN mobile text;
ALTER TABLE companies ADD COLUMN initial_admin_user_id uuid;
ALTER TABLE companies ADD COLUMN initial_delivery_address_id uuid;
ALTER TABLE companies ADD CONSTRAINT companies_initial_admin_scope_fk
  FOREIGN KEY (id, initial_admin_user_id) REFERENCES users (company_id, id);
ALTER TABLE companies ADD CONSTRAINT companies_initial_address_scope_fk
  FOREIGN KEY (id, initial_delivery_address_id) REFERENCES delivery_addresses (company_id, id);
