# Cursor coordinator: keep its reading tools out of the data directory

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from
[6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3, which closed
the data directory on Pi and OpenCode but could not on Cursor.

### Tasks

1. **Choose and build a path check for Cursor's reading tools**: a read-only Cursor coordinator's `read`, `grep`, `glob` and `ls` still reach Orkestrator's data directory. Status: open.
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

**Investigation.** `@cursor/sdk` 1.2.0 gives no per-call hook that sees a
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

### 2. Qualify it on a live Cursor turn

**Problem.** Either option changes how the SDK runs tools, and only a real turn
shows that the check fires and that ordinary reads still work.

**Context.** Cursor's model is hosted; there is no loopback provider, so every
qualifying turn is billed. The fake engine (`src/testing/fake-engine-server.ts`)
replaces the SDK and cannot prove an executor override.

**Investigation.** None yet.

**Decisions.**

- **How to qualify?**
  - **One billed read-only coordinator turn that reads a fixture data directory directly, through a link in the checkout, and reads the checkout (recommended).**
    - Pros: one turn covers every case, the way the OpenCode qualification does.
    - Cons: billed, and needs a Cursor login on the qualifying host.
  - **Unit-test the executor wrappers only.**
    - Pros: free.
    - Cons: does not show the SDK calls them.

## Related

- [6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3
- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#which-environments-a-coordinator-may-act-on)
