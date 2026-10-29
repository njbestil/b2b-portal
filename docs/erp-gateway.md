# ERP gateway foundation

B2B-033 establishes the backend-only `ErpGateway` port in
`apps/api/src/integrations/erp-gateway.ts` and a working `MockErpAdapter` in
`apps/api/src/infrastructure/`. The initial operation is
`checkAvailability(signal): Promise<boolean>`. It is read-only and ERP-neutral:
application code receives a boolean, not Mock payloads, HTTP responses or URLs.
`createErpHealthProbe` consumes the port; only API startup imports the concrete
adapter. A future real ERP adapter can implement the same interface.

## Deliberate scope

This is an availability foundation, not a completed commercial ERP API. Mock
master data is now seeded separately by [B2B-032](mock-erp-master-data.md).
Catalog synchronization (B2B-034), order submission,
idempotency, retries, cancellations and invoices remain separate issues. Extend
the port with typed business operations as their endpoints/workflows are built.
There are no fake successes, empty master-data responses or invented order methods
for currently unimplemented operations. ERP retains authoritative data ownership.

## Configuration

The Portal API alone consumes these optional server-environment settings:

| Variable         | Default | Meaning                                                     |
| ---------------- | ------- | ----------------------------------------------------------- |
| `ERP_BASE_URL`   | absent  | Mock ERP API base, e.g. `http://127.0.0.1:3001/mock-erp/v1` |
| `ERP_TIMEOUT_MS` | 1000    | Integer 1–60000; whole adapter request/body deadline        |

A missing/blank URL disables the adapter and leaves ERP `unconfigured`; timeout
settings are ignored in that case. A supplied URL must use HTTP(S), without URL
credentials, query parameters, fragments or surrounding whitespace. Invalid
settings fail startup with setting names/rules only, never their values. A trailing
slash is normalized so `health` preserves any configured base-path prefix.

Copy `.env.example`, set the local base URL above, build the workspaces, then run
the Mock ERP and API in separate terminals:

```sh
npm start --workspace=@b2b-portal/mock-erp
npm start --workspace=@b2b-portal/api
```

No database or ERP master data is required to exercise
the ERP probe. Storage remains independently unconfigured until PostgreSQL is set.
Use HTTPS for remote deployment. Treat the base URL as trusted backend configuration,
not a client-supplied parameter. The frontend never calls the Mock ERP directly.

## Mock protocol and health behavior

The Mock ERP exposes `GET /mock-erp/v1/health` with `Cache-Control: no-store` and
HTTP 200 JSON `{ "status": "up" }`. Existing `GET /` behavior is unchanged.
The adapter uses native Node fetch and translates that wire format into the
neutral availability result. No dependencies or HTTP framework objects enter the
application port or shared frontend contracts.

Each check performs fresh I/O, accepts caller cancellation and has its own deadline.
Redirects are not followed. Non-success responses, connection failures, malformed
JSON/UTF-8, unexpected payloads, non-JSON media types and bodies over 4096 decoded
bytes are unavailable. Response streams are cancelled/released, timers cleared,
and cancellation listeners removed. Upstream bodies, URLs and exception text are
not returned or logged. No application retries or persistent health cache are added.

The existing Portal API `/health` reporter also has a 1000 ms dependency deadline.
A reporter deadline reports `timeout` and aborts the adapter. An adapter returning
false reports `down`. An unavailable/absent dependency means overall HTTP 503;
both storage and ERP up mean HTTP 200. When deadlines coincide, the first completed
deadline determines down versus timeout. Availability only proves the Mock process
responds correctly; it says nothing about seeded data, schema or order acceptance.

## Verification

Run root `npm run check`, or `npm test --workspace=@b2b-portal/api`. The latter also
builds the Mock ERP for its real-process integration test; production API builds
remain independent of the Mock service build.

Tests cover structural alternate gateways, compile-time rejection of provider
payloads, configuration/redaction, URL prefix handling, response validation/size,
redirect refusal, stalled headers/body, caller cancellation, safe API envelopes
and real Mock ERP/API processes. Existing environment tests also verify the Mock
health route while retaining its standalone root response. The gateway remains
health-only; the separate Mock master-data snapshot does not add real ERP access,
business gateway methods, migrations or deployment.
