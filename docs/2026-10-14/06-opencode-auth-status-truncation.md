# OpenCode reports "needs auth" while a provider is connected

Status: Fixed 2026-10-15. `authStatus()` now derives `state` from
`connected` within the model-provider allowlist, independent of the list cap;
the bounded `providers` list puts connected, then allowlisted, providers
first; and the needs-auth hint names the allowlisted providers to connect.
Covered by `apps/backend/src/core/opencode-capabilities.test.ts`. The live
provider count was still not measured; the fix holds either way.

**Severity: low to medium.** The card is wrong but turns still work. It
misleads users into "fixing" a login that is fine, and anything gated on the
auth state inherits the error.

## Symptom

With `opencode-go` connected and OpenCode turns succeeding, Agent Info's
runtime card showed:

> OpenCode — needs auth — Connect a provider from OpenCode settings.

## Root cause

`OpenCodeCapabilities.authStatus()`
(`apps/backend/src/core/opencode-capabilities.ts:92-121`), reached through
`OpenCodeProvider.authStatus()` (`opencode-provider.ts:1323`) and rendered at
`AgentInfoButton.tsx:1394` and `1445-1448`:

```ts
const connected = Array.isArray(data?.connected) ? data.connected : [];
const providers = Array.isArray(data?.all) ? data.all : [];
const normalized = providers.slice(0, 128).flatMap(/* signed-in iff connected.includes(id) */);
state: normalized.some((p) => p.state === "signed-in") ? "signed-in" : "needs-auth",
```

The rule itself is platform-neutral (any connected provider counts), but the
list is cut to 128 **before** connectivity is checked. OpenCode's `all` lists
every provider it knows about, and the catalogue code's own comment says that
list overflows a 128-provider budget (`opencode-model-catalog.ts:231-234`,
which filters before capping for exactly this reason). If the connected
provider sits past index 127, it is dropped, and the state becomes
`needs-auth`.

## Fix

1. Compute `state` from `connected` directly (signed in when `connected` is
   non-empty, or non-empty within the allowlist), independent of the
   `providers` list cap.
2. Build the bounded `providers` list with connected providers first, so the
   ones that matter survive the cap, matching `normalizeOpenCodeComposerCatalog`.
3. Add a test. Nothing covers OpenCode `authStatus` today; projection tests
   only stub it. Use a `provider.list` fixture with more than 128 providers and
   the connected one last.
4. Optionally make the hint actionable, for example by naming the allowlisted
   providers that are not connected.
