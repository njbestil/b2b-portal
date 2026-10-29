-- B2B-010: physical mapping of the approved logical MVP model (requirements 3.8-3.9).
-- Run only through the migration runner. UUIDs are supplied by the application.
-- ERP-designated fields below are synchronized references, never portal authority.

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL CHECK (btrim(legal_name) <> ''),
  trade_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DEACTIVATED')),
  contact_name text,
  contact_email text,
  contact_phone text,
  trade_license_reference text,
  billing_address jsonb CHECK (jsonb_typeof(billing_address) = 'object'),
  erp_customer_reference text UNIQUE,
  credit_status text,
  payment_terms text,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX companies_status_idx ON companies (status, id);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  company_id uuid REFERENCES companies (id),
  email text NOT NULL CHECK (email = btrim(email) AND email <> ''),
  password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
  display_name text NOT NULL,
  role text NOT NULL
    CHECK (role IN ('INTERNAL_ADMIN', 'SALES_STAFF', 'CUSTOMER_ADMIN', 'CUSTOMER_USER')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DEACTIVATED')),
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_role_company_check CHECK (
    (role IN ('CUSTOMER_ADMIN', 'CUSTOMER_USER') AND company_id IS NOT NULL)
    OR (role IN ('INTERNAL_ADMIN', 'SALES_STAFF') AND company_id IS NULL)
  ),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email));
CREATE INDEX users_company_role_status_idx ON users (company_id, role, status, id);

CREATE TABLE customer_sales_assignments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  sales_staff_user_id uuid NOT NULL REFERENCES users (id),
  is_primary boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  assigned_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  CHECK (NOT active OR ended_at IS NULL)
);
CREATE UNIQUE INDEX assignments_one_active_primary_idx
  ON customer_sales_assignments (company_id) WHERE active AND is_primary;
CREATE UNIQUE INDEX assignments_active_pair_idx
  ON customer_sales_assignments (company_id, sales_staff_user_id) WHERE active;
CREATE INDEX assignments_sales_active_idx
  ON customer_sales_assignments (sales_staff_user_id, active, company_id);

CREATE TABLE delivery_addresses (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  label text NOT NULL,
  address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT is_default OR active),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX addresses_one_active_default_idx
  ON delivery_addresses (company_id) WHERE active AND is_default;
CREATE INDEX addresses_company_active_idx ON delivery_addresses (company_id, active, id);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  erp_product_reference text NOT NULL UNIQUE,
  sku text NOT NULL UNIQUE CHECK (btrim(sku) <> ''),
  name text NOT NULL,
  category text,
  brand text,
  selling_uom text NOT NULL CHECK (btrim(selling_uom) <> ''),
  minimum_order_quantity numeric NOT NULL
    CHECK (minimum_order_quantity > 0 AND minimum_order_quantity < 'Infinity'::numeric),
  pack_size text,
  active boolean NOT NULL,
  available_quantity numeric
    CHECK (available_quantity >= 0 AND available_quantity < 'Infinity'::numeric),
  default_price numeric CHECK (default_price >= 0 AND default_price < 'Infinity'::numeric),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  price_valid_from timestamptz,
  price_valid_to timestamptz,
  synced_at timestamptz,
  CHECK ((default_price IS NULL) = (currency IS NULL)),
  CHECK (price_valid_from IS NULL OR price_valid_to IS NULL OR price_valid_to > price_valid_from)
);
CREATE INDEX products_active_category_brand_idx ON products (active, category, brand, id);

CREATE TABLE customer_product_access (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  product_id uuid NOT NULL REFERENCES products (id),
  eligible boolean NOT NULL,
  synced_at timestamptz,
  UNIQUE (company_id, product_id)
);
CREATE INDEX product_access_product_idx ON customer_product_access (product_id);

CREATE TABLE customer_product_prices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  product_id uuid NOT NULL REFERENCES products (id),
  amount numeric NOT NULL CHECK (amount >= 0 AND amount < 'Infinity'::numeric),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz,
  valid_to timestamptz,
  synced_at timestamptz,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (company_id, product_id)
);
CREATE INDEX customer_prices_product_idx ON customer_product_prices (product_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  order_number text UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  delivery_address_id uuid,
  order_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (order_status IN ('DRAFT', 'PENDING_CUSTOMER_CONFIRMATION', 'SUBMITTED',
      'CONFIRMED', 'FULFILLING', 'DELIVERED', 'CANCELLED', 'REJECTED')),
  integration_status text NOT NULL DEFAULT 'NOT_SENT'
    CHECK (integration_status IN ('NOT_SENT', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING')),
  idempotency_key text UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  erp_order_reference text UNIQUE,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  total_amount numeric CHECK (total_amount >= 0 AND total_amount < 'Infinity'::numeric),
  order_snapshot jsonb CHECK (jsonb_typeof(order_snapshot) = 'object'),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, delivery_address_id) REFERENCES delivery_addresses (company_id, id)
);
CREATE INDEX orders_company_created_idx ON orders (company_id, created_at DESC, id);
CREATE INDEX orders_company_status_created_idx ON orders (company_id, order_status, created_at DESC, id);
CREATE INDEX orders_creator_idx ON orders (created_by_user_id, id);
CREATE INDEX orders_delivery_address_idx ON orders (company_id, delivery_address_id);
CREATE INDEX orders_integration_status_idx ON orders (integration_status, updated_at, id);

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity < 'Infinity'::numeric),
  unit_price numeric CHECK (unit_price >= 0 AND unit_price < 'Infinity'::numeric),
  line_total numeric CHECK (line_total >= 0 AND line_total < 'Infinity'::numeric),
  item_snapshot jsonb CHECK (jsonb_typeof(item_snapshot) = 'object'),
  UNIQUE (order_id, product_id),
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
CREATE INDEX order_items_company_order_idx ON order_items (company_id, order_id, id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE order_confirmations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE,
  customer_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  decided_by_user_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at timestamptz,
  CHECK (status <> 'REJECTED' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id),
  FOREIGN KEY (company_id, customer_user_id) REFERENCES users (company_id, id),
  FOREIGN KEY (company_id, decided_by_user_id) REFERENCES users (company_id, id)
);
CREATE INDEX confirmations_customer_status_idx ON order_confirmations (customer_user_id, status, created_at);
CREATE INDEX confirmations_company_order_idx ON order_confirmations (company_id, order_id);
CREATE INDEX confirmations_decided_by_idx ON order_confirmations (company_id, decided_by_user_id);

CREATE TABLE order_cancellation_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by_user_id uuid REFERENCES users (id),
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at timestamptz,
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
CREATE UNIQUE INDEX cancellations_one_pending_idx
  ON order_cancellation_requests (order_id) WHERE status = 'PENDING';
CREATE INDEX cancellations_company_status_idx ON order_cancellation_requests (company_id, status, created_at DESC);
CREATE INDEX cancellations_requester_idx ON order_cancellation_requests (requested_by_user_id);
CREATE INDEX cancellations_decider_idx ON order_cancellation_requests (decided_by_user_id);

CREATE TABLE integration_transactions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('NOT_SENT', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING')),
  retryable boolean NOT NULL DEFAULT false,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  request_payload jsonb CHECK (jsonb_typeof(request_payload) = 'object'),
  response_payload jsonb CHECK (jsonb_typeof(response_payload) = 'object'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
CREATE INDEX integration_company_order_idx ON integration_transactions (company_id, order_id, created_at DESC);
CREATE INDEX integration_retry_queue_idx ON integration_transactions (status, next_retry_at, id) WHERE retryable;
CREATE INDEX integration_status_created_idx ON integration_transactions (status, created_at DESC, id);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  erp_invoice_reference text NOT NULL UNIQUE,
  invoice_number text NOT NULL,
  status text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0 AND amount < 'Infinity'::numeric),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  document_reference text,
  issued_at timestamptz,
  synced_at timestamptz,
  FOREIGN KEY (company_id, order_id) REFERENCES orders (company_id, id)
);
CREATE INDEX invoices_company_issued_idx ON invoices (company_id, issued_at DESC, id);
CREATE INDEX invoices_order_idx ON invoices (company_id, order_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  target_type text,
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at timestamptz
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC, id) WHERE read_at IS NULL;

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  company_id uuid REFERENCES companies (id),
  actor_user_id uuid REFERENCES users (id),
  actor_role text CHECK (actor_role IN ('INTERNAL_ADMIN', 'SALES_STAFF', 'CUSTOMER_ADMIN', 'CUSTOMER_USER')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_company_created_idx ON audit_logs (company_id, created_at DESC, id);
CREATE INDEX audit_actor_created_idx ON audit_logs (actor_user_id, created_at DESC, id);
CREATE INDEX audit_target_created_idx ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX audit_action_created_idx ON audit_logs (action, created_at DESC, id);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  refresh_token_hash text NOT NULL UNIQUE CHECK (btrim(refresh_token_hash) <> ''),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_expiry_idx ON user_sessions (user_id, expires_at, id);
CREATE INDEX sessions_expiry_idx ON user_sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE CHECK (btrim(token_hash) <> ''),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_resets_user_expiry_idx ON password_reset_tokens (user_id, expires_at, id);
CREATE INDEX password_resets_expiry_idx ON password_reset_tokens (expires_at);
