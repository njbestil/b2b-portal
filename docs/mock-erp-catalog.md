# Synthetic Mock catalog source

Producer for #144 / consumer #47. GET /mock-erp/v1/catalog is a trusted
development/test ERP surface, not a customer route. The portal must authorize
the actor/company before choosing customerId. No mock controls belong in public routes.

Required customerId is DEMO-C001 or DEMO-C002. Optional name, sku, category and
brand are case-insensitive literal substrings combined with AND. availability
is available, unavailable or unknown. offset defaults to 0 (0–100000), limit
defaults to 20 (1–100). Fields accept a single nonempty string of at most 128
characters. Unknown/repeated/malformed parameters return 400 INVALID_CATALOG_QUERY.
Results sort by productId ascending and return source: synthetic-mock-erp,
customerId, items, total, offset and limit; reads have Cache-Control: no-store.

Items retain the existing master-data product, exact decimal/UOM/MOQ fields and
unchanged default/customer pricing records (including effective windows).
Additional category/brand labels are explicitly synthetic fixtures.
eligibility is the raw matching customer record; prices contains all default and
matching customer inputs, not a resolved price. Inactive and ineligible products
remain visible in this producer source. #47 owns filtering by policy, time-window
selection and customer overrides, together with cache/HTTP integration.

availableQuantity is an exact decimal string or null. Zero is unavailable;
absent inventory is unknown and never available. DEMO-CATALOG-UNKNOWN is an
additional catalog-only Case fixture, MOQ 0.125, explicitly eligible for both
demo customers, with absent prices and inventory. Existing synchronization
master-data fixtures are unchanged. No monetary calculation or rounding occurs.

This is a fixed read-only snapshot. There are no writes, timers, network calls,
order/invoice mutations or production ERP fallback. #47 must deliberately adapt
this contract; this PR does not claim the parent gateway/cache is connected.
