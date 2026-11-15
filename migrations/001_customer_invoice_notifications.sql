BEGIN;

ALTER TABLE notifications
DROP CONSTRAINT IF EXISTS notifications_kind_check;

ALTER TABLE notifications
ADD CONSTRAINT notifications_kind_check
CHECK (kind IN (
  'order_email',
  'order_whatsapp',
  'contact_email',
  'contact_whatsapp',
  'customer_invoice_email'
));

COMMIT;
