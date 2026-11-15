CREATE TABLE IF NOT EXISTS stores (
  slug text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  whatsapp text NOT NULL,
  payment_key text,
  shipping_cents integer NOT NULL CHECK (shipping_cents >= 0),
  enabled boolean NOT NULL DEFAULT false,
  access_until timestamptz,
  subscription_status text NOT NULL DEFAULT 'pending',
  subscription_code text UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS client_billing_email ON stores (lower(email)) WHERE slug <> 'nocturne';
CREATE TABLE IF NOT EXISTS products (
  store_slug text REFERENCES stores(slug),
  sku text,
  name text NOT NULL,
  size text NOT NULL,
  notes text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  image_position integer NOT NULL DEFAULT 50 CHECK (image_position BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (store_slug,sku)
);
CREATE TABLE IF NOT EXISTS purchases (
  ref uuid PRIMARY KEY,
  store_slug text NOT NULL REFERENCES stores(slug),
  customer jsonb NOT NULL,
  items jsonb NOT NULL,
  shipping_cents integer NOT NULL,
  amount integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  shipped_at timestamptz
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY,
  store_slug text NOT NULL REFERENCES stores(slug),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_links (
  ref uuid PRIMARY KEY,
  store_slug text NOT NULL UNIQUE REFERENCES stores(slug),
  amount integer NOT NULL,
  plan text NOT NULL,
  authorization_url text,
  paid_at timestamptz
);
CREATE TABLE IF NOT EXISTS billing_receipts (
  ref text PRIMARY KEY,
  store_slug text NOT NULL REFERENCES stores(slug)
);
CREATE TABLE IF NOT EXISTS notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_slug text NOT NULL REFERENCES stores(slug),
  kind text NOT NULL CHECK (kind IN ('order_email','order_whatsapp','contact_email','contact_whatsapp','customer_invoice_email')),
  subject_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  claim_token uuid,
  claimed_at timestamptz,
  claimed_until timestamptz,
  UNIQUE (kind, subject_id)
);