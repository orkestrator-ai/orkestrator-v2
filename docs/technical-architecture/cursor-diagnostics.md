# Cursor stall investigation

Cursor now uses the [shared bridge diagnostics](bridge-diagnostics.md).
## Investigation on 2026-09-09

A Grok 4.6 review through Cursor SDK 1.0.31 stopped emitting persisted SDK
events at 08:27:27 UTC. The bridge remained responsive, with one shell call and
three task calls pending and no shell subprocess remaining. The equivalent
read-only Git diff completed independently in 13 ms. No terminal result or
exposed approval explained the wait.

The installed SDK drops upstream heartbeat frames before its public interaction
updates, and its persisted SDK messages collapse partial and started tool calls
into the same `running` status. Therefore those historical messages cannot
establish whether the tools actually began execution or locate the upstream
stall. The diagnostics preserve that distinction for future incidents without
changing cancellation, retry, approval, or timeout behaviour.

## Multi-review startup failure on 2026-09-09

The 23:25 UTC local review failed in `agent.send` before producing an assistant
message. Its persisted bridge session contained `Local SDK sandboxing was
requested, but sandboxing is not supported in this environment`; the backend
presented that as a generic dispatch HTTP 500. The installed macOS sandbox
helper was present and executable.

SDK 1.0.31 registers `cursorsandbox` only when constructing a sandbox-enabled
executor. An earlier unsandboxed preparation can request environment metadata,
which asks whether sandboxing is supported. The SDK caches the negative answer
before the helper is registered and never invalidates it. A subsequent read-only
review or consolidation therefore fails despite the helper being available.

`sandbox-bootstrap.ts` initializes sandbox discovery through the SDK's public
workspace prewarm API before the first host attach. Concurrent attaches await
the same initialization. The temporary executor has no settings sources or MCP
servers, dispatches no turn, and releases its lease. Container sessions skip it;
their outer sandbox remains the boundary. Unsupported hosts still admit normal
unsandboxed sessions, while read-only sessions retain their sandbox requirement
and closed tool allowlist.

The barrier is settled by a probe that reached a lease, or by the SDK's
"sandboxing is not supported in this environment" verdict, which is final. Any
other failure leaves `cursorsandbox` unregistered, so the next host attach
probes again rather than letting one transient error reinstate the failure for
the rest of the process. Neither swallowed failure changes the attach it was
observed on; both write a single `setup-failed` diagnostic line, carrying the
error message only, under the cursor bridge debug flag.

The diagnosis was reproduced against the installed SDK by constructing an
unsandboxed executor, invoking its sandbox-support metadata callback, then
constructing a sandboxed executor. The latter threw the same error. Performing
the bootstrap first made both executors succeed and the metadata report support.
The earlier unused-initial-run fix addresses a separate failure and remains
necessary.
