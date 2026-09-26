# 03 — Discover connections and authenticate the client

Status: Planned.
Depends on: [01](01-public-command-and-compatibility-contract.md),
[02](02-client-and-service-entrypoints.md).
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

The CLI connects to the intended already-running backend through its existing
gateway. An invalid explicit profile or connection fails without trying the
production instance. Credentials stay in private local configuration and
request headers; machine-readable output identifies the target safely.

## Owners and starting points

- [Backend readiness](../../../../apps/backend/src/main.ts).
- [Gateway auth](../../../../apps/backend/src/gateway-auth.ts) and
  [base](../../../../apps/backend/src/gateway-base.ts).
- [Runtime profile contract](../../../../apps/desktop/electron/runtime-profile.ts)
  and [profile I/O](../../../../apps/desktop/scripts/dev/profile-io.ts).
- [Fixture gateway client](../../../../apps/desktop/scripts/dev/fixture.ts).
- Proposed CLI connection store, selector, and HTTP adapter.

## Work

1. Fix selector precedence: explicit `--connection NAME` or `--profile NAME`,
   otherwise an explicitly saved default. Reject both explicit selectors
   together. Resolve profiles through the same validated status contract as
   `dev:status`; require readiness and obtain the published endpoint/auth path.
2. Add an installed-instance descriptor contract because development manifests
   are not a production discovery mechanism. Publish backend instance/generation,
   data-root identity, endpoint, protocol version, and credential-file reference
   atomically with private permissions after readiness. Reuse existing descriptor
   publication if suitable; stale generations must be detectable.
3. Define connection registration for a named local or remote endpoint. It can
   be a private config-file import initially; a `connection add` convenience
   must use a private credential file or hidden input, never a token argument.
   `list`, `show`, and `check` print only redacted identity and availability.
4. Validate response identity against the selected descriptor. A recycled port,
   moved data directory, or restart must not silently bind a pending receipt to
   another installation. Permit a verified generation change within the same
   installation for reconciliation; reject identity mismatch.
5. Implement bounded authenticated invoke calls, request deadlines, cancellation,
   response-size/schema validation, and domain-outcome decoding. Never follow
   redirects with authorization headers. Support explicit authenticated remote
   connections without weakening existing gateway network/origin rules.
6. Read gateway credentials inside the client. Control MCP tokens are not
   interchangeable. Redact URLs with credentials and reject malformed private
   config files without dumping their contents. Token rotation gets a bounded
   credential refresh for safe reads; do not automatically replay a mutation.
7. Treat request deadlines and lost responses as transport uncertainty when
   mutation bytes may have reached the server. Preserve the request identity
   for step 05; do not convert this into proof that admission failed.
8. Keep connection reads safe in untrusted workspaces: no project-local default
   connection file, automatic operator-token discovery for workers, or credential
   widening. The initial CLI is an explicitly configured operator client.
9. Ensure private connection/profile helpers can be used from the published
   package without importing Electron or depending on repository-relative paths.
   Extract a pure shared contract only where necessary.

## Verification

Exercise explicit/default precedence, absent and stale profiles, stopped
backends, recycled ports, malformed descriptors, identity mismatch, remote
failure, auth rotation, redirects, and oversized responses. Use two disposable
instances to prove no fallback crosses into the second one. Inspect captured
stdout/stderr for credential sentinels; verify metadata file permissions.

Include a real gateway request with the selected auth file. Mock transport only
for precise timeout/redirect behavior. Reuse existing gateway auth regression
coverage instead of retesting its entire policy in the CLI suite.

## Acceptance and handoff

- [ ] CLI can inspect both a managed dev profile and an explicitly configured instance.
- [ ] Explicit selection failure produces no request to any fallback instance.
- [ ] Credentials never appear in command output, URLs, or diagnostics.
- [ ] A connection check verifies identity and capabilities before mutation.
- [ ] Client exit releases HTTP resources without stopping the backend.

Descriptor additions must be additive to existing readiness consumers. Disabling
client discovery leaves desktop/service startup intact; preserve stored
connections and operation receipts across a client downgrade.
