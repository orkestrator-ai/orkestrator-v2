# Upgrading Codex

A runbook for moving Orkestrator to a newer Codex CLI / app-server release.

The Codex binary and the generated app-server protocol bindings are only valid
**as a matched pair**. `codex app-server` is still marked experimental, so a
version bump can change request shapes, notification names and item unions. The
whole process below exists to make those changes visible in a diff instead of at
runtime.

> **Read first:** [`docs/adr/0001-codex-app-server-engine.md`](adr/0001-codex-app-server-engine.md)
> for why the pinning and contract tests exist.

---

## TL;DR

```bash
# 1. Bump the single source of truth
$EDITOR config/codex-version.json          # version + appServerProtocol.generatedFrom

# 2. Mirror it into the three other pins (see step 2)
# 3. Refresh the hash-pinned managed artifacts (see step 3)

# 4. Regenerate protocol bindings from the NEW binary
CODEX_PROTOCOL_BINARY=/path/to/new/codex bun run codex:protocol

# 5. Review the protocol diff — this is the real review surface
git diff --stat bridges/codex-bridge/src/app-server/generated
git diff bridges/codex-bridge/src/app-server/generated/protocol-manifest.json

# 6. Verify
bun run codex:protocol:check
bun test tests/unit/version-drift.test.ts
bun run --cwd bridges/codex-bridge typecheck
RUN_LIVE_CODEX_APP_SERVER=1 bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
bun run test

# 7. Replay recorded fixtures — catches a rename the type diff cannot
bun test bridges/codex-bridge/src/app-server/notification-replay.test.ts
```

---

## Step 1 — Bump the source of truth

Everything starts at `config/codex-version.json`:

```json
{
  "version": "0.146.0",
  "appServerProtocol": {
    "generatedFrom": "0.146.0",
    "outputDir": "bridges/codex-bridge/src/app-server/generated"
  }
}
```

`version` and `appServerProtocol.generatedFrom` **must** match — the generator
refuses to run otherwise. They are separate fields on purpose: if you ever need to
pin a binary without regenerating, the mismatch is an explicit, visible decision
rather than silent drift.

## Step 2 — Mirror the version into the other three pins

`tests/unit/version-drift.test.ts` fails until all of these agree with
`config/codex-version.json`:

| File | What to change |
| --- | --- |
| `scripts/download-codex.sh` | `CODEX_VERSION="…"` |
| `apps/desktop/electron/toolchain-manifest.ts` | `PINNED_TOOLCHAIN_VERSIONS.codex` |
| `docker/Dockerfile` | `ARG CODEX_CLI_VERSION=…` |

The bridge has no npm dependency on Codex — it speaks JSON-RPC to the binary — so
there is no package.json pin to bump. That test also asserts `@openai/codex-sdk`
stays absent, so a stray reinstall cannot resurrect the old execution path.

Check it early — it is cheap and catches a missed pin before you spend time on
hashes:

```bash
bun test tests/unit/version-drift.test.ts
```

## Step 3 — Refresh the managed-toolchain hashes

`toolchain-manifest.ts` pins **four Codex artifacts** (darwin arm64/x64, linux
arm64/x64), each with an archive *and* an extracted-executable size + SHA-256.
That is **16 values** per upgrade, and all of them change.

Download each artifact once and print the values in manifest form:

```bash
RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
  bun scripts/verify-toolchain-artifacts.ts --emit --tool=codex
```

Output is paste-ready:

```
Hashing codex:darwin:arm64 0.146.0
  // codex:darwin:arm64
  archive.size:      102_106_051,
  archive.sha256:    "072a30a6…",
  executable.size:   271_134_288,
  executable.sha256: "1da3f4e0…",
```

Paste each block into the matching artifact in `toolchain-manifest.ts`, then
confirm by asserting rather than emitting:

```bash
RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
  bun scripts/verify-toolchain-artifacts.ts --tool=codex
```

> Downloads roughly 400MB. Narrow it with `--platform=darwin --arch=arm64` while
> iterating, but land the change with all four verified — a wrong hash on a
> platform you did not test bricks the managed toolchain for those users.

## Step 4 — Regenerate the protocol bindings

The generator needs a binary that reports the **new** pinned version.

- If `CODEX_PROTOCOL_BINARY` is set it is treated as an **assertion**: a missing,
  unrunnable, or wrong-version binary is a hard error. It deliberately does *not*
  fall back — otherwise pointing at the new binary while forgetting to bump
  `config/codex-version.json` would silently generate bindings from the old
  managed binary, which would then match the committed artifacts and pass
  `--check`, hiding the mistake.
- Otherwise it auto-discovers: the managed toolchain copy of the pinned version,
  then `CODEX_PATH`, then `codex` on `PATH`. Each candidate's `--version` is
  checked, so a stale binary is skipped rather than used.

```bash
bun run codex:protocol
```

This rewrites `bridges/codex-bridge/src/app-server/generated/typescript/` (617
files at 0.145.0) and `protocol-manifest.json`.

Two details worth knowing:

- **Import specifiers are rewritten.** `ts-rs` emits extensionless relative
  imports, which do not resolve under the bridge's `NodeNext` config. The
  generator appends `.js` as part of generation, so `--check` compares normalized
  output against normalized output and stays exact.
- **The JSON Schema bundle is not committed.** Nothing reads it at runtime, and
  3.5MB of generated JSON would bury the signal in a protocol diff. Its digest
  *is* committed, so a schema-only change still fails the check. Digests
  canonicalize JSON first because `generate-json-schema` serializes `definitions`
  from a Rust `HashMap` — two runs of the *same* binary emit different key order.

## Step 5 — Review the protocol diff

**This is the actual review surface for the upgrade.** Start with the manifest,
which summarises the method surface:

```bash
git diff bridges/codex-bridge/src/app-server/generated/protocol-manifest.json
```

Then look at what moved:

```bash
git diff --stat bridges/codex-bridge/src/app-server/generated/typescript
```

### What to look for

| Change | Why it matters | Where to react |
| --- | --- | --- |
| New `serverRequestMethods` entry | An unanswered server request **hangs a turn forever**. The exhaustive `switch` will fail to typecheck — that is the design. | `app-server/server-request-router.ts` |
| Removed/renamed `clientRequestMethods` entry | A method the bridge calls has gone. | `engine/app-server-engine.ts` |
| New `serverNotificationMethods` entry | Falls through to `unknown.protocol` and is counted, not fatal. Decide: reduce it, or add to `IGNORED_METHODS`. | `app-server/event-reducer.ts` |
| New `ThreadItem` variant | Renders as nothing and increments `unsupportedItems`. | `app-server/item-adapter.ts` |
| Changed status enum | e.g. a new `CommandExecutionStatus`. Silently maps to the `default` branch. | `app-server/item-adapter.ts` |
| `clientUserMessageId` or `userMessage.clientId` gone | **Stop.** At-most-once dispatch depends on these; without them an ambiguous dispatch cannot be reconciled. | Escalate — do not ship |
| `ThreadSourceKind` changed | A dropped root kind silently empties the resume dialog. | `ROOT_THREAD_SOURCE_KINDS` in `engine/app-server-engine.ts` |

`tests/unit/codex-app-server-protocol.test.ts` guards the load-bearing subset
(`clientUserMessageId`, `userMessage.clientId`, the root source kinds, the methods
the bridge calls) and runs without the binary, so it fails in ordinary CI if any of
them disappear.

## Step 6 — Verify

Cheap, no binary needed:

```bash
bun run codex:protocol:check                    # committed artifacts == pinned binary
bun test tests/unit/version-drift.test.ts       # every pin agrees
bun test tests/unit/codex-app-server-protocol.test.ts
bun run --cwd bridges/codex-bridge typecheck    # exhaustiveness failures land here
bun test bridges/codex-bridge/src
```

Against the real binary — **the non-negotiable gate**:

```bash
RUN_LIVE_CODEX_APP_SERVER=1 \
  bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
```

These 11 tests spend no credits and call no model. They pin behaviour that is not
expressible in the type system:

- `initialize` returns `codexHome` and identifies us as `orkestrator`
- requests before `initialized` are rejected
- unknown methods return a JSON-RPC error rather than hanging
- `model/list` paginates and its reasoning-effort order is **not** alphabetical
- `thread/list` needs explicit `sourceKinds`
- `thread/read(includeTurns=true)` **rejects an unmaterialized thread** — recovery
  depends on distinguishing this from a real read failure
- a read-only thread does **not** mark the project trusted; a workspace-write one
  **does**

Then the full suite:

```bash
bun run test
```

Finally, exercise the bridge against the new binary. Nothing else proves the spawn
arguments, JSONL framing over real pipes and the route wiring still line up:

```bash
bun test bridges/codex-bridge/src/app-server-http.test.ts
```

That test uses a fake binary, so it is fast and free. For a real smoke test — note
this **dispatches an actual model turn and spends credit**:

```bash
WS=$(mktemp -d) && (cd "$WS" && git init -q . && git commit -q --allow-empty -m init)
CODEX_BRIDGE_NO_SERVER=1 CODEX_PATH=/path/to/new/codex CWD="$WS" \
  bun bridges/codex-bridge/src/testing/http-flag-harness.ts
```

Expect health `state: "ready"` with the new `codexVersion`,
`models` with `source: "app-server"`, a `202` prompt carrying `threadId`/`turnId`,
and the duplicate prompt returning `duplicate: true` with the **same** `turnId`.

Finally rebuild the container, since it installs Codex from npm at the pinned
version:

```bash
bun run docker:build
```

---

## Step 7 — Replay the recorded fixtures

The protocol diff tells you what *types* changed. The fixtures tell you whether
anything the UI actually renders changed — a renamed field or a new item variant
that the reducer now drops on the floor, which shows up as a blank transcript
rather than as an error.

```bash
bun test bridges/codex-bridge/src/app-server/notification-replay.test.ts
```

Two failure modes, and they mean different things:

- **`unknownMethods` or `unsupportedItemTypes` is non-empty.** The new version
  emits something the reducer does not handle. Either add it to `IGNORED_METHODS`
  in `event-reducer.ts` (if it genuinely carries nothing we render), or handle it.
  Silently dropping it is what makes a transcript go blank.
- **A snapshot changed.** Read the diff. A part appearing, disappearing or changing
  `toolState` is a real rendering change and needs a decision, not a `--update`.

### Re-recording after a bump

Committed fixtures are recordings of an *older* Codex. After a significant bump,
recording fresh ones is what keeps this check honest:

```bash
# Both variables are required: recording persists prompts and file contents, so
# it never activates from a single stray value in a checked-out `.env`.
CODEX_BRIDGE_RECORD_NOTIFICATIONS=/tmp/codex-recordings \
  CODEX_BRIDGE_RECORD_CONFIRM=1 bun run dev
# …drive the scenario in the UI, then:
bun scripts/scrub-codex-recording.ts /tmp/codex-recordings/<file>.jsonl \
  bridges/codex-bridge/src/testing/fixtures/<scenario>.jsonl
```

`bridges/codex-bridge/src/testing/fixtures/README.md` lists the scenarios worth
covering and tracks which are done.

**A raw recording contains your prompts, file contents, absolute paths, and
anything an agent read into context — including credentials.** The scrubber is a
safety net, not a guarantee: it cannot recognise a secret it has no pattern for.
Always read the diff before committing. `bun scripts/scrub-codex-recording.ts
<file> --check` exits non-zero if anything would still be redacted.

---

## If a live contract test fails

Each failure maps to a specific decision. Do not just update the assertion.

**Trust mutation changed.** Today a writable sandbox writes
`[projects."<cwd>"] trust_level = "trusted"`, and `codex exec
--sandbox danger-full-access` — which build mode already uses — writes the same
entry, so app-server adds nothing. If a new version *broadens* this (e.g. a
global setting, or read-only also marking trust), that is a new user-visible side
effect and needs a product decision, not a test edit.

**`thread/read` no longer rejects unmaterialized threads.** If it starts returning
empty turns, `isUnmaterializedThreadError` stops matching. Verify recovery still
treats "no matching `clientId`" as *definitely did not run*; if the error text
changed but the behaviour did not, update the matcher in `app-server/errors.ts`.

**`thread/list` default widened.** If the default now includes `exec`/`appServer`,
keep sending explicit `sourceKinds` anyway. Relying on a default that changed once
is how the resume dialog empties.

**`model/list` reasoning order became alphabetical.** The live test asserts it is
*not* sorted, to catch us accidentally sorting it. If upstream genuinely emits
sorted order, relax that assertion — but never sort client-side; app-server
documents the order as meaningful.

---

## Rollback

The version pin, the generated bindings and the toolchain hashes are one atomic
unit. Revert them together:

```bash
git revert <upgrade commit>
bun install
bun run codex:protocol:check   # must pass against the OLD binary
```

Note that `config.toml` project-trust entries and Codex rollout files written by
the newer version are **not** reverted. Rollouts are forward-compatible in
practice, but a downgrade is not something the contract tests cover — verify a
resume of a thread created by the newer version before relying on it.

There is no engine flag to fall back to: app-server is the only engine, and the
`codex exec` path was removed. If a Codex release breaks the bridge rather than
just the bindings, the lever is downgrading the pin above, not switching engines.

---

## Reference

| Path | Role |
| --- | --- |
| `config/codex-version.json` | Single source of truth |
| `scripts/generate-codex-app-server-protocol.ts` | Generator; `--check` for CI |
| `scripts/verify-toolchain-artifacts.ts` | `--emit` to print hashes, default asserts |
| `bridges/codex-bridge/src/app-server/generated/` | Committed bindings + manifest (do not hand-edit) |
| `tests/unit/version-drift.test.ts` | All pins agree |
| `tests/unit/codex-app-server-protocol.test.ts` | Load-bearing protocol subset, no binary needed |
| `bridges/codex-bridge/src/app-server/live-contract.test.ts` | Real-binary contract gate |

| Command | Purpose |
| --- | --- |
| `bun run codex:protocol` | Regenerate bindings |
| `bun run codex:protocol:check` | Fail on drift |
| `RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts --emit --tool=codex` | Print new hashes |
| `RUN_LIVE_CODEX_APP_SERVER=1 bun test …/live-contract.test.ts` | Real-binary gate |
| `bun test bridges/codex-bridge/src/app-server-http.test.ts` | Engine flag + spawn + routes, with a fake binary |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `CODEX_PROTOCOL_BINARY` | Explicit binary for generation/live tests |
| `CODEX_PATH` | Binary the bridge runs |
| `CODEX_BRIDGE_NO_ENGINE` | Set to `1` to import the bridge without spawning app-server |
| `CODEX_BRIDGE_NO_SERVER` | Set to `1` to import the bridge without binding a port |
| `CODEX_BRIDGE_RECORD_NOTIFICATIONS` | Directory to record the inbound app-server stream into, for replay fixtures. Requires `CODEX_BRIDGE_RECORD_CONFIRM=1` as well. Recordings contain prompts and file contents — scrub before committing. |
| `CODEX_BRIDGE_RECORD_CONFIRM` | Must be `1` to arm recording. The second variable exists so a stray directory value alone cannot silently start persisting user data. |
| `CODEX_BRIDGE_RECORD_MAX_BYTES` | Caps one recording (default 64MB) |
| `RUN_LIVE_CODEX_APP_SERVER` | Enables real-binary contract tests |
| `RUN_LIVE_TOOLCHAIN_ARTIFACTS` | Enables artifact download/verification |
