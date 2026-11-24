# Customer processing updates (#67)

The customer-only /orders/processing view reads the existing authenticated
company order-history API. A link from draft details opens the view. It uses
the supplied design's panels, badges, notice and Check status pattern with the
existing CSS/components. No backend contract, data ownership or navigation
architecture changes. Full history/detail/timeline and checkout remain #60 and
their workflow issues.

Finite business/technical states become fixed customer messages. Failed submitted
processing tells the customer to contact the sales team before placing it again;
it never prints technical codes, error payloads, retry counts, ERP references or
promises that an interrupted job automatically resumes. Confirmed/fulfilling and
terminal business states take precedence over an unrelated technical failure.
No timeline dates, delivery estimates or acceptance are invented.

The adapter projects known fields, checks company identity, strict envelopes,
states and pagination, and fails unavailable for malformed/foreign data. Preview,
internal/Sales and restricted accounts cannot read this customer view. Loading,
empty, denied, unavailable, paging and explicit refresh states are accessible;
late results are suppressed after navigation or identity changes. There is no
write or automatic polling.
