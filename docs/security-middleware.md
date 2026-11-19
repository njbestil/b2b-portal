# API security middleware (#100)

All API responses carry restrictive API security headers and omit Express's identifying header. TLS termination and an appropriate HSTS policy remain deployment responsibilities; the API does not infer external HTTPS from untrusted proxy headers.

An API-wide fixed-window guard allows 600 requests per direct socket peer per minute, per process. It uses no forwarded IP headers and caps its peer table at 1,000 active entries; a new peer receives 429 with `Retry-After` while the table is full. Expired entries are removed on subsequent requests. GET and HEAD `/health` bypass this guard so rate exhaustion does not make readiness probes fail. Existing tighter route-specific guards remain in effect. A 429 does not imply that a write was attempted.

This is a bounded local safeguard, not a distributed rate limiter. Restarting a process clears its counters; instances do not share them. Behind a reverse proxy, all clients using the same connection peer share a bucket. Deployments must enforce appropriately configured, distributed client-aware limits at the trusted ingress and account for shared peers before exposing the service. Do not enable trust of arbitrary forwarded addresses.

Write routes retain their explicit JSON media-type, validation and uncompressed body limits (typically 2–16 KiB). The fallback parser also rejects compressed JSON and limits it to 16 KiB. This is not a general raw-stream upload limit; routes accepting other content types must establish their own bounded parser and validation. Node and the ingress remain responsible for connection, header, timeout and raw request limits. Existing authorization and route-specific request validation remain required.
