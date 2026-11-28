/** Private read evidence for a Sales-created order's retained customer approval.
 * Use only in a company-scoped query on the orders table. Never expose as HTTP data. */
export const confirmedOrderApproverSql = `(SELECT c.decided_by_user_id FROM order_confirmations c JOIN users maker ON maker.id=orders.created_by_user_id WHERE c.order_id=orders.id AND c.company_id=orders.company_id AND c.status='CONFIRMED' AND maker.role='SALES_STAFF' AND maker.company_id IS NULL)`;
