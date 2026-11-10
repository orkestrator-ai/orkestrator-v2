# Cursor coordinator: keep its reading tools out of the data directory

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from
[6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3, which closed
the data directory on Pi and OpenCode but could not on Cursor. Task 1 built
2026-11-10 against `main` at `c98b20e6f` (`@cursor/sdk` 1.3.1).

### Tasks

1. **Choose and build a path check for Cursor's reading tools**: a read-only Cursor coordinator's `read`, `grep`, `glob` and `ls` still reach Orkestrator's data directory. Status: done (2026-11-10: replacement executors that check every path, tested with fakes; see Current state).
2. **Qualify it on a live Cursor turn**: Cursor's model is hosted, so no loopback run can prove either option. Status: open (depends on 1).

### 1. Choose and build a path check for Cursor's reading tools

**Problem.** A read-only Cursor coordinator runs as the user with the tool
allowlist `CURSOR_READ_ONLY_TOOLS` (`bridges/cursor-bridge/src/agent-session.ts`):
`read`, `grep`, `glob`, `ls`, `readLints`, `semSearch` and Orkestrator's own
tools, with no shell. Nothing checks those tools' paths, so the coordinator can
read `control-mcp.json`, `config.json`, the database and every account's login,
including Cursor's own credential, which lives in the data directory by design.

**Context.** The launcher names the directory in
`ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR` for every coordinator bridge, so
the Cursor bridge can read which directory it must protect. The path logic is
shared in `@orkestrator/protocol/node/coordinator-read-boundary`
(`protectedDataDirBoundary`, `readBoundaryRefuses`); Pi's
`bridges/pi-bridge/src/read-boundary.ts` is a worked example of applying it to
one provider's tool arguments.

**Investigation.** `@cursor/sdk` 1.2.0 (and 1.3.1, rechecked 2026-11-10) gives no per-call hook that sees a
built-in tool's path: it has no approval callback, and settings-file hooks load
only with a `settingSources` layer the read-only coordinator deliberately
leaves out. It offers two ways in, both on `AgentOptions.local`:

- `resourceProviderOptions` with `overrideReadExecutor`, `overrideGrepExecutor`
  (which also serves glob) and `overrideLsExecutor`. The SDK types these only by
  shape (`LocalToolExecutor`), because the executor interfaces are not
  published, and an override replaces the host executor rather than wrapping
  it, so the bridge would have to reimplement reading, searching and listing.
- `fs`, a `FileSystem` tree the native file tools run on instead of the host
  disk. With `fs` set, `ReadLints` and `SemanticSearch` are not registered, no
  hooks run, no skills are discovered and host git status never reaches the
  model, and the SDK exports no host-disk `FileSystem`, only composition helpers
  (`overlayFs`, `readOnlyFs`, `unionFs`).

Whether Cursor's provider sandbox already confines these tools is not
established: it is documented for commands, and the tools run in the SDK's own
process.

**Decisions.**

- **How to check Cursor's reads?**
  - **Override the read, grep and ls executors with thin ones that check the path and delegate to the bridge's own implementation (recommended).**
    - Pros: keeps `readLints`, `semSearch` and skills; the check runs on every call, links resolved.
    - Cons: the executor shape is unpublished and can change on any SDK bump; the bridge owns three tool implementations.
  - **Run read-only coordinators on an `fs` tree that leaves the data directory out.**
    - Pros: the SDK enforces it; nothing outside the tree is reachable at all.
    - Cons: loses `readLints`, `semSearch` and skills, and needs a host-disk `FileSystem` the SDK does not export.
  - **Leave it and say so in the tier note.**
    - Pros: no work; Cursor is already `provider-configured`.
    - Cons: a coordinator keeps credentials wider than its own.

**Outcome (2026-11-10).** Built as the recommended option. A read-only
coordinator's agent is attached with `local.resourceProviderOptions` whose
`overrideReadExecutor`, `overrideGrepExecutor` and `overrideLsExecutor` check
the path and delegate to the bridge's own implementation; see Current state.

### 2. Qualify it on a live Cursor turn

**Problem.** Either option changes how the SDK runs tools, and only a real turn
shows that the check fires and that ordinary reads still work.

**Context.** Cursor's model is hosted; there is no loopback provider, so every
qualifying turn is billed. The fake engine (`src/testing/fake-engine-server.ts`)
replaces the SDK and cannot prove an executor override.

**Investigation.** Not run: it needs a Cursor login and a billed turn, which
this host's constraints rule out. What is proven without one (task 1's tests)
is the executors' behaviour when called the way the SDK calls them, and that
every field they return exists in the SDK 1.3.1 bundle's own message
descriptors. What only a live turn shows:

- that the SDK calls the overrides for the model's `read`, `grep`, `glob` and
  `ls` calls, and for an MCP call's `$file:` argument;
- that the plain-object results serialise, including a digest-only read
  (the SDK clones the value) and a `Uint8Array` image read;
- that the model can still work in the checkout: ordinary reads, searches,
  globs and listings return what the SDK's own executors would.

Steps: on a host with a Cursor login, start a throwaway `dev:test` profile,
give it a fixture data directory (`ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`
is set by the launcher for a coordinator), put a link in the checkout to a
fixture file in it and one to the directory, and ask a Cursor coordinator in
one turn to read the fixture file directly, through each link, to grep the
checkout for its contents, to glob `**/*.json`, to list the parent of the
data directory, and to read and grep a checkout file. Expect the first four
refused or filtered (the refusal reason says "data directory") and the rest
answered.

**Decisions.**

- **How to qualify?**
  - **One billed read-only coordinator turn that reads a fixture data directory directly, through a link in the checkout, and reads the checkout (recommended).**
    - Pros: one turn covers every case, the way the OpenCode qualification does.
    - Cons: billed, and needs a Cursor login on the qualifying host.
  - **Unit-test the executor wrappers only.**
    - Pros: free.
    - Cons: does not show the SDK calls them.

## Current state

- `bridges/cursor-bridge/src/read-boundary.ts`: the boundary
  (`cursorCoordinatorReadBoundary`, from
  `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`, allowing the checkout and the
  coordinator's attachment directory, as on Pi), Cursor's path spellings
  (`file://`, `~`, relative to the workspace) and the three executors. A path
  inside the data directory, directly or through a link, is refused before
  anything is read: Read answers `rejected` with a reason that names the data
  directory, Grep and Glob an `error`, LS `rejected`. A search or listing
  rooted above the directory still runs, and every file it would return is
  checked, because searches follow links.
- `bridges/cursor-bridge/src/read-tools.ts`: the bridge's own Read (text with
  the SDK's line range and `maxChars` rules, images and PDFs as bytes, binary
  refused, 8 MiB cap), Grep and Glob (the SDK's ripgrep, found as the SDK
  finds it and never from the workspace; content, files and count modes;
  offset, head limit and a 2000-entry cap) and LS (ripgrep's file list as the
  SDK's tree with its character budget).
- `agent-session.ts` sets the overrides only on a read-only attach in a
  process launched with a protected data directory, i.e. a coordinator; every
  send repeats them through `agentLocalOptions`.
- Tests: `read-boundary.test.ts` (a fixture data directory, links from the
  checkout, the attachment allowance), `read-tools.test.ts` (each tool's
  behaviour, and every returned field checked against the installed SDK
  bundle's message descriptors), `agent-session-read-boundary.test.ts` (which
  attaches get the overrides).

## Assumptions and decisions

### Task 1: plain objects instead of the SDK's message classes

The executors return plain objects. The SDK does not export its protobuf
classes; its runtime (protobuf-es 1.x) converts a plain object into the
message class wherever a result is placed in a message, and the one place
that calls a method on a result value (the digest-only read wrapper calls
`clone()`) is served by a non-enumerable `clone` on a successful read's value.
Building messages through the runtime of the arguments the SDK passes was
possible but would have tied the bridge to more of the SDK's internals.
Whether this holds in a live turn is task 2.

### Task 1: what the replacements do not reproduce

Recorded in the header of `read-tools.ts` so a reader of the code sees it:
only the workspace root's `.cursorignore` is honoured, by Grep and LS, and a
`glob` filter overrides it (ripgrep's globs override ignore files); Read does
not consult it. Images are returned unresized. Searches run outside Cursor's
provider sandbox. None of these widens what reaches the data directory, and
all apply only to read-only coordinators. `readLints` and `semSearch` keep the
SDK's executors: they return diagnostics and index hits, not files the turn
names, and replacing them would mean reimplementing Cursor's language and
index services.

### Task 1: refusing only roots inside the data directory

Pi refuses a search rooted above the data directory outright. Here such a
search runs and every result is checked instead, because the per-file check
is needed anyway (a search of the checkout follows links into the data
directory) and refusing would make a coordinator unable to search or list a
parent of the data directory, such as the user's home, at all.

## Related

- [6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3
- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#which-environments-a-coordinator-may-act-on)
