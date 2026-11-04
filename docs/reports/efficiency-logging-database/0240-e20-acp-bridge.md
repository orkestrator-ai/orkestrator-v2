# E20: ACP bridge

This file combines 3 reports into one batch to build together. Remove the dead code first.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0270](#0270-acps-cursor-replay-looks-like-dead-code) | Low | BR-16: ACP's Cursor replay looks like dead code |
| [0260](#0260-acp-stdout-framing-is-quadratic-for-large-frames) | Low | BR-12: ACP stdout framing is quadratic for large frames |
| [0240](#0240-acp-still-serialises-every-session-on-each-state-write) | Low | BR-1 (remainder): ACP still serialises every session on each state write |

## 0270: ACP's Cursor replay looks like dead code

### Task analysis

#### Tasks

1. **Remove the Cursor branches from the ACP bridge**: delete the replay and repoint its test harness. Status: open.

#### 1. Remove the Cursor branches from the ACP bridge

**Problem.** The ACP bridge carries a replay path gated on `provider === "cursor"` that spawns a whole agent child per pass. Production runs Cursor through its own bridge, so this looks unreachable, and it adds code and tests to a sensitive module.

**Context.** The report calls it "likely dead code and a deletion candidate". The impact is about maintenance, not run-time cost, since a path that never runs costs nothing.

**Investigation.** Production: `apps/backend/src/core/commands-servers.ts` starts Cursor with the Cursor bridge settings (`CURSOR_BRIDGE_AUTH_FILE`) and reaches `env.ACP_PROVIDER = kind` (`:1172`) only in its later branch. `loadAcpProviderConfig` (`bridges/acp-bridge/src/acp-provider-config.ts:86-102`) has only Grok built in, though `ACP_PROVIDER_CONFIG` can name any id. The gates are `acp-tools.ts:570`, `:688` and `:810`, with labels at `acp-errors.ts:47` and `session-config.ts:84`.

The tests are the catch. `acp-test-harness.ts:246` defaults to `ACP_PROVIDER: "cursor"`, and `testing/fake-agent-context.ts:7` falls back to `"cursor"`, so the harness default has to change as well, and many suites may depend on it.

**Decisions.**

- **Delete, or keep it for a future ACP Cursor?**
  - **Delete the replay and the gates, and move the harness to Grok or a neutral id (recommended).**
    - Pros: removes a path no production launch reaches; the replay's reconciliation logic is large and has its own tests.
    - Cons: a wider diff than it sounds, because of the harness default; tests that use Cursor's generic labels need rewriting or removal.
  - **Leave it.**
    - Pros: no risk to the suites.
    - Cons: the code keeps being maintained for nothing.

### Constraints and rationale

- `bridges/acp-bridge/AGENTS.md` asks for standard ACP to be implemented generically. Only the Cursor-specific parts go; anything generic that uses them stays.

### Open questions

- Does anyone set `ACP_PROVIDER_CONFIG` to a Cursor id by hand? Nothing in the repository does outside tests, as far as the search reached.

## 0260: ACP stdout framing is quadratic for large frames

### Task analysis

#### Tasks

1. **Frame stdout with a chunk list and scan offset**: stop copying and rescanning the buffer on each chunk. Status: open.

#### 1. Frame stdout with a chunk list and scan offset

**Problem.** Each stdout chunk copies the whole pending buffer and searches it again from the start, so a large frame costs in proportion to its size squared.

**Context.** The shared SSE decoder had the same flaw and is fixed (GW-4). Codex's client is the report's model.

**Investigation.** `bridges/acp-bridge/src/acp-context.ts:1386` does `Buffer.concat([this.#stdoutBuffer, chunk])`, then `indexOf(0x0a)` from zero (`:1388`). The frame limit is `MAX_LINE_BYTES`, 4 MiB (`:870`), enforced at `:1390` and `:1399`. Codex keeps `bufferScannedTo` so a scan resumes where it stopped (`bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:246`), but over decoded text, so it cannot be copied as it is: ACP buffers bytes.

**Decisions.**

- **Where does the code live?**
  - **In `acp-context.ts`: search only the new chunk for a newline, and join chunks when one arrives (recommended).**
    - Pros: small and local; a newline cannot straddle a chunk, as it is one byte.
    - Cons: the helper stays ACP's own.
  - **A shared JSONL framer in `packages/protocol/src/node`.**
    - Pros: theme T4's direction.
    - Cons: a protocol change for a low-impact fix, and Codex's version would have to move too, which its stdout rule makes riskier.

### Constraints and rationale

- The oversized-frame close must still fire at the same limit, both for a terminated and an unterminated line.

### Needs verification

- The size ACP frames reach in practice. Reasoned from the limit, not measured.

## 0240: ACP still serialises every session on each state write

### Task analysis

#### Tasks

1. **Decide whether to cache clean sessions' fragments**: the report's last BR-1 fix, not done when the interval was lowered. Status: open.

#### 1. Decide whether to cache clean sessions' fragments

**Problem.** The write rate fell from about one per 25 ms to one per second while a turn streams, but each write still does the whole job: at least three serialisation passes over up to 256 sessions, up to the 16 MB cap.

**Context.** The report lists three fixes: a trailing debounce, keeping `persistState()` barriers, and "cache each clean session's serialised fragment". 1202 marks BR-1 done, and its decision of 2026-11-01 covers only the interval. The third fix was not built and was not explicitly declined.

**Investigation.** In `bridges/acp-bridge/src/acp-persist-writer.ts`, `persistedSnapshot` (`:105`) measures structured entries, journals and config per session with `JSON.stringify` (`:126`, `:135`, `:148`, `:173`). `boundPersistedSnapshot` (`:39`) serialises metadata and messages again (`:52`, `:59`), and the write serialises the lot once more (`:293`). No per-session cache exists. Sessions other than the streaming one are unchanged between writes, so most of this repeats.

**Decisions.**

- **Build the cache now?**
  - **Measure a write on a large state first, and build it only if the once-a-second cost shows (recommended).**
    - Pros: the rate fix already removed most of the cost; the bounds in `persistedSnapshot` work across sessions, newest first, so a fragment depends on its neighbours and the cache is not simple.
    - Cons: a turn on a backend holding many large sessions keeps paying in the meantime.
  - **Cache each clean session's fragment by session revision.**
    - Pros: the report's fix; writes approach the cost of the session that changed.
    - Cons: every state change must move the revision; a missed one writes stale state to disk, the worst failure for this file.

### Current state

Done, checked in code:

- `scheduleStreamingPersist` writes at most once per `STREAMING_PERSIST_INTERVAL_MS` (1 s) with a timer later chunks do not reset, so it is also the maximum wait (`acp-persist-writer.ts:239-249`; #1548, `12289fc56`). Its callers are `acp-session.ts:2160` and `acp-tools.ts:193`.
- `persistState()` barriers remain for the dispatch journal.

### Constraints and rationale

- A crash can lose at most one interval of output, by the 2026-11-01 decision.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any cache needs byte and count bounds.

### Needs verification

- What a write costs at the cap; nothing here was run. 1202 notes that BR-1 has no new test.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-16, BR-12, BR-1)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which lists BR-1 as done
- [0355](0130-e21-pi-bridge.md#0355-pi-persistence-serialises-every-session-on-each-write): the same pattern in Pi
