# Customer confirm/reject (#73 / B2B-061)

Normal Customer User or Customer Admin GET/POST
`/api/v1/orders/:orderId/confirmation`, without tenant/query selectors.
Customer User must be the designated contact; any normal Customer Admin in that
same active company may decide. Sales and Internal Admin cannot approve.
Current credential/session/role/company and access expiry are checked under the
provider ownership boundary. The source order must have a Sales creator and one
unsent request; no ERP/submission evidence is accepted.

POST has exactly `{confirmationId,decision,reason}`. Decision is CONFIRMED or
REJECTED. Confirm requires reason=null; reject requires nonblank plain text up
to 1,000 characters. The server trims the reason. An exact decision by the same
actor replays its retained identity/date; opposing decisions, changed reason,
different actor replay or wrong request ID conflict. One decision wins races.

Confirm updates only the confirmation and order timestamp; business state remains
PENDING_CUSTOMER_CONFIRMATION until #74 validates and submits. It does not mean
ERP confirmation. Reject atomically records the reason/actor/date and marks the
order REJECTED. Integration remains NOT_SENT. There is no ERP call or notification
promise. Current pricing and stock must be validated before eventual submission.

SQL reuses existing decision columns and locks company, actor/session, order and
confirmation. JSON extends the recognized private child and publishes it with
the order through a synced temporary file and one rename. Existing writers keep
that child; unknown private data is refused. JSON remains single-process with
external writers offline. No migration or dependency change is required.

Reads return the safe decision and own order quantities/product labels/delivery,
never private notes, fingerprints or credential/provider data. Product labels
are current descriptive fields, not a submitted financial snapshot or price
quote. The customer review dialog follows the ZIP structure using native dialog,
labelled reason, explicit commands, pending/error states and refresh after an
uncertain mutation. History links pending orders to the review page.

Each successful command/replay writes an audit event without rejection text or
contact details. Post-commit audit/acknowledgement failure is unconfirmed, not
rollback: refresh before another command. There is no automatic write retry.
API responses are no-store, 2 KiB-body bounded and rate/concurrency limited.
