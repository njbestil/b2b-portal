# Mock technical and permanent submission outcomes (#146; consumer #64)

This is producer test data, not a retry engine. #146 stacks on #145: merge #145
first, then #146. The [submission contract](mock-erp-submissions.md) remains
authoritative for exact snapshots, immutable receipts, request limits and lifetime.

Only the trusted standalone Mock accepts X-Mock-ERP-Scenario. Missing/success is
normal acceptance. There are no environment-selected failures, hidden counters,
automatic recovery, portal/customer controls, network calls or real ERP fallback.
The header must be explicitly selected by a test/gateway harness.

| Scenario                 | HTTP / source code                                      | Input classification         |
| ------------------------ | ------------------------------------------------------- | ---------------------------- |
| timeout                  | 1500 ms then 504 ERP_TIMEOUT (or caller deadline first) | Technical, retryable input   |
| unavailable              | 503 ERP_UNAVAILABLE                                     | Technical, retryable input   |
| temporary-server-failure | 500 ERP_TEMPORARY_FAILURE                               | Technical, retryable input   |
| validation               | 200 rejected / ERP_VALIDATION_FAILED                    | Permanent business rejection |
| credit-hold              | 200 rejected / CREDIT_HOLD                              | Permanent business rejection |
| insufficient-stock       | 200 rejected / INSUFFICIENT_STOCK                       | Permanent business rejection |
| invalid-item             | 200 rejected / INVALID_ITEM                             | Permanent business rejection |

Technical submission failures return
{externalRequestReference,portalOrderId,customerId,error:{code,message}},
with fixed safe messages and no-store. They allocate no receipt/order/invoice,
so a later explicit switch to success with the same request may create one order.
Repeated selected technical failures remain failures; there is no fail-once
counter. The finite timeout timer is aborted when the client disconnects and
never creates an order later. A network-level deadline cannot deliver a response
body; the caller must retain its own request correlation for that case.

Business rejections retain the original correlated terminal receipt and create
no order. Repeating the same external reference replays it even if success or a
technical scenario is selected later. Retained accepted/existing-order receipts
likewise replay before failure injection. Conflicting bodies still fail with
IDEMPOTENCY_CONFLICT, never a synthetic technical failure. Unknown controls and
invalid bodies stay safe 400 errors; oversized/unsupported requests retain parser
errors. Capacity/conflict/parser errors are not the named technical fixtures.

#64 must explicitly map these codes/outcomes and transport deadlines to its
approved bounded retry policy. A 200 response is not sufficient to infer ERP
acceptance; inspect outcome. Do not classify every 500, 409 or validation failure
as retryable. No retry scheduling, maximum-attempt handling, manual authorization
or portal integration/business status transition is implemented by this producer.

Legacy /orders also accepts temporary-server-failure with 500
ERP_TEMPORARY_FAILURE, using its existing {error:{code,message}} envelope and
legacy non-retained failure behavior. New permanent receipt semantics apply to
/submissions only. Invoice/fulfillment/cancellation controls remain unchanged.
