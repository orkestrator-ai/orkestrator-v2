# 06 — Build the streaming HTTP forwarding path

Status: Not started. Depends on: 04–05. Unlocks: 07 and private publication.

## Outcome and owners

Serve an application's full path space through an authorized service endpoint
without rewriting its HTML, CSS, or JavaScript. Keep the legacy rewriting path
separate. Build proposed `preview-http-proxy.ts`, `preview-header-policy.ts`,
and `preview-admission.ts` modules rather than extending the large existing
[gateway proxy](../../../../apps/backend/src/gateway-proxy.ts) indefinitely.

Inspect [existing header helpers](../../../../apps/backend/src/gateway-support-extra.ts)
and [gateway handlers](../../../../apps/backend/src/gateway-handlers.ts). Extract
only helpers whose semantics fit both paths. Agent API credential translation
must not become the new general application-auth behavior.

## Request pipeline

Implement an explicit sequence:

1. Classify ingress as a supported preview listener/host/attachment.
2. Validate HTTP shape and header limits; reject malformed authority, ambiguous
   framing, invalid port/path forms, and unsupported CONNECT behavior.
3. Authenticate the scoped attachment/session and apply origin/CSRF policy.
4. Resolve its fixed service endpoint and compare epoch/generation.
5. Acquire per-service and backend admission slots before connecting upstream.
6. Derive upstream headers through the selected Host/Origin policy, strip all
   transport credentials, and preserve application auth.
7. Connect with bounded deadlines and verified TLS when supported.
8. Stream request and response with backpressure and cancellation.
9. Release every reservation/listener/timer on success, rejection, abort, and
   error. Cleanup must be exactly-once in effect even when called repeatedly.

The request never chooses its destination through a URL parameter or forwarded
Host header. Recheck generation immediately before connect; reject rather than
switching a partially admitted request to a replacement application.

## HTTP semantics

Cover GET/HEAD and body-bearing methods, chunked uploads, streaming responses,
SSE, redirects, binary data, and repeated Set-Cookie fields. Strip standard
hop-by-hop headers plus fields nominated by `Connection`. Treat HTTP upgrade
as the distinct step-07 path. Define unsupported trailer/Expect behavior
explicitly and test it; do not accidentally deadlock `100-continue` uploads.

Preserve ordinary app Authorization and cookies while consuming preview auth.
Reject upstream attempts to set reserved transport cookie names. For dedicated
origins, keep `Path=/` valid for `__Host-` application cookies; do not prefix it.
Application Domain values that do not match the public preview host require
documented application configuration or an explicit validated cookie policy.
Never blindly widen cookie scope.

Choose one documented public-authority policy per service. Usually applications
should learn the preview origin through configured public URL/trusted forwarding
metadata, while upstream Host satisfies the app's host validation. Strip
incoming forwarding headers and construct a trusted bounded set. Preserve or
map Origin only according to the authenticated original origin and chosen
policy. Framework adapters must not default to permissive host allowlists.

Pass relative redirects unchanged. Rewrite a private absolute redirect only
when it is verified to refer to this same service and is mapped to its public
origin. Preserve the redirect's path/query without logging them. Cross-service
and external redirects require the navigation policy; the server must not
follow them using privileged credentials.

No body transformation means representation ETags, digests, ranges, and SRI can
remain intact. Do not decompress/recompress merely out of habit. Either pass a
negotiated upstream representation through or deliberately use the existing
bounded compression policy, updating affected headers correctly. Honor HEAD,
204/205/304, 206, `no-transform`, and content encoding. Stream the first HTML
chunk immediately; waiting for `end` fails this step's central acceptance case.

## Resource and failure policy

Use step-02 admission/body/header/queue limits. Separate connect, response-header,
ordinary-body-idle, and long-lived-stream policies. An actively progressing
response does not hit an absolute 30-second request deadline. SSE sessions may
be quiet; choose heartbeat/idle expectations without inventing application
payloads. Tie final lifetime to the access lease.

Disconnect cancels upstream connect/read/write. Backpressure pauses reads;
bounded overflow closes the affected stream, never silently drops application
bytes. After headers are sent, propagate failure by ending/destroying the
connection as appropriate; do not write a JSON error into an HTML/file stream.
Failures before response start return a stable safe preview error. Do not
automatically replay POST, PUT, PATCH, DELETE, uploads, or other ambiguous work.

For the legacy route, add the missing connect/header/rewrite idle admission
controls and honor its rewrite bounds. Keep compatibility fixes separate from
new-route semantics to make regressions attributable. Raising the 8 MiB rewrite
limit is not a substitute for streaming full-origin delivery.

## Tests and completion

Use real loopback fixture servers for byte/stream behavior, not only mocked
`http.request`. Verify first chunk before upstream completion; chunked request
backpressure; exact binary hashes; duplicate Set-Cookie; app bearer auth; denied
transport cookies; ranges/304/SRI; compressed bodies; abort during connect,
headers, upload, and response; and slots released on every path.

Include a header-only stall, an endless body, an oversized declared body, an
oversized chunked body, and a client that stops reading. Assert bounds by
observable counters, not timing guesses. Prove a congested preview does not
block backend control events or another service. Test upstream HTTPS with a
fixture CA and wrong-name/untrusted certificates if advertising that capability.

Exit with the new proxy reachable through an authenticated fixture ingress,
legacy focused tests still passing, and no production route enabled without
scoped auth. Record any unsupported HTTP feature in negotiated capabilities.
