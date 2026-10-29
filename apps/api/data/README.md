# JSON data directory

B2B-011 supplies a backend JSON file store and the existing read-port adapters.
It does not ship a demo dataset or configure the application's active provider.

Keep local runtime data in `runtime/` (Git-ignored), or configure another private,
trusted directory and ensure it is untracked. Never commit real customer data,
credentials, sessions, generated files or temporary publication files.

The initial collections are companies, users, products, customer_product_access,
customer_product_prices and order summaries. See [JSON storage](../../../docs/json-storage.md)
for file formats, explicit replacement semantics and limitations. Missing files are
errors, not permission to create an empty dataset or switch providers. Later seed/reset
work belongs to B2B-013; provider composition belongs to B2B-012.
