-- A portal order has one initial submission attempt and retained request.
CREATE UNIQUE INDEX integration_one_order_submission_idx
  ON integration_transactions (company_id, order_id)
  WHERE operation = 'ORDER_SUBMISSION';
