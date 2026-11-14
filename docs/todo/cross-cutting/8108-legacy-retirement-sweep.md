# Retire all legacy support in one sweep

The user (maintainer) decided on 2026-11-14: "Retire all legacy support
applies at this point in time to everything in the repo." One sweep removes
every older-version compatibility path, adapter, fallback and support-window
wait. All machines and clients are updated together, so no peer older than
the current release has to be served.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Written from the user's
decision; nothing here has been built.

### Tasks

1. **Inventory every remaining compatibility path and give each an owner**: list the register rows, usage counters and adapters still in the tree, and assign each to the to-do that already removes it or to task 5. Status: open.
2. **Remove the container `kind: "legacy"` readiness path**: from 7571 task 9. Status: open.
3. **Remove `ServiceBrowserTab` compatibility mode, the legacy loopback route and annotations on legacy URL tabs**: from 0042 task 8. Status: open.
4. **Retire mixed-version qualification**: the workflow, the scenarios and the qualifiers that pair today's code with older releases. Status: open.
5. **Remove the paths task 1 leaves unowned**: each with its tests and a Retired row. Status: open (depends on 1).

### 1. Inventory every remaining compatibility path and give each an owner

**Problem.** Older-version code is spread over the backend, the bridges, the
renderer, the protocol's client adapters and stored-data readers, and the
to-dos that owned it each waited on a different support-window date. Without
one list, the sweep will miss paths or two workers will remove the same one.

**Context.** The register in
[version-compatibility.md](../../architecture/version-compatibility.md#register)
names every path with its owner and removal condition, and its Retired table
records what went. `apps/backend/src/core/compatibility-path-usage.ts` names
about fifty counted paths (for example `bridge-close.upgrade-required`,
`bridge-transcript.messages-fallback`, `history.joined-v1-page`,
`preview.legacy-loopback-route`, `preview.tunnel-v1`, `machine-load.older-node`,
the `retired-command.*` names and `relayed-node-event.legacy-stream`). Domain
contracts keep client adapters for older domain versions
(`packages/protocol/src/contract/client-adapters.ts`; see
[Client adapters](../../architecture/version-compatibility.md#client-adapters)).
To-dos that already own a removal and were unblocked on 2026-11-14:
[0050](../transcripts-and-observation/0050-transcript-history-efficiency.md),
[0232](../transcripts-and-observation/0232-direct-history-cursor-minting.md),
[7570](7570-compatibility-paths-waiting-on-the-floor.md),
[0078](0078-legacy-prompt-queue-claim-state.md),
[6080](../coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md)
task 7, [4740](4740-workflow-vocabulary-stage-two.md) and
[2960](2960-host-prefixed-gateway-cookie.md).

**Investigation.** Paths seen on 2026-11-14 with no open task that removes
them: the restart notice for bridges that predate `POST /session/:id/close`
(`BridgeCloseUnsupportedError` and the `bridge-close.upgrade-required`
counter, beside [0002](../agent-engines/0002-session-lifecycle-consistency.md));
the Cursor state file's legacy `overflow` boolean;
[5800](5800-file-read-streaming-leftovers.md)'s base64 readers kept for older
clients; [0047](../previews-and-annotations/0047-web-annotation-extensions.md)'s
shadow-scope fallback for older backends; and the backend's handling of
bridges that predate the `mcpConfigReporting` marker
([0039](../mcp/0039-mcp-management.md)). Not checked yet: every row of the
register and every counter name.

**Decisions.**

- **What counts as legacy support?**
  - **Code that exists only so an older backend, bridge, renderer, CLI, iOS
    build or node can talk to today's (recommended).** Readers that upgrade
    data already on disk (a stored record, a saved layout, a container built
    before a change) are user state, not version skew, and stay unless their
    own to-do says otherwise.
    - Pros: matches the decision ("all machines and clients are updated
      together") without losing a user's stored data; the same line the
      unblocked to-dos drew (for example 0078 keeps its load pass, 5860 is
      unmigrated user state).
    - Cons: each stored-data reader still needs its own judgement.
  - **Everything marked legacy, stored-data readers included.**
    - Pros: the most code removed.
    - Cons: a user's existing data stops loading; the decision was about
      versions, not data.
- **Who removes a path another to-do already owns?**
  - **That to-do (recommended).** This file lists it and links there.
    - Pros: no duplicate work; the owning file has the detail.
    - Cons: the sweep finishes only when those files do.
  - **This file, taking the work over.**
    - Pros: one place.
    - Cons: two files describing one removal.

### 2. Remove the container `kind: "legacy"` readiness path

**Problem.** `parseBootProbe` and `observeContainerBoot`
(`apps/backend/src/core/container-readiness.ts`) still treat a container with
no `/run/orkestrator` directory and no boot-status capability label as an
image from before boot status, which only images built before v2.21.0 are.

**Context.** [7571](7571-removal-candidates-needing-a-decision.md) task 9 left
it for the container-lifecycle owner. The user decided on 2026-11-14 to remove
it with its tests and add a Retired row. Current images no longer write the
pre-boot-status marker files (7571 task 3).

**Investigation.** None beyond 7571's. A container from such an image will be
reported as never ready and must be rebuilt; say so in the readiness failure
text.

**Decisions.**

- **What does a pre-boot-status container show afterwards?**
  - **The ordinary not-ready failure, with a rebuild remedy (recommended).**
    - Pros: no special case left; the remedy is the one users already see.
    - Cons: a user with such a container learns of it only when it fails.
  - **A dedicated "image too old, rebuild" failure code.**
    - Pros: a precise message.
    - Cons: keeps a detector for the very images the decision retires.

### 3. Remove `ServiceBrowserTab` compatibility mode, the legacy loopback route and annotations on legacy URL tabs

**Problem.** The legacy loopback route breaks `__Host-` cookies, strips CSP,
has no WebSocket support and shares one origin across apps. It stayed only for
old clients and stored legacy tabs.

**Context.** [0042](../previews-and-annotations/0042-service-preview-rollout.md)
task 8 and its D30: on 2026-11-14 the user decided to remove
`ServiceBrowserTab` compatibility mode and the legacy loopback route now, with
annotations on legacy URL tabs, and no support-window wait. The code, as 0042
found it: `GatewayProxy.proxyToTarget` (`apps/backend/src/gateway-proxy.ts`,
counting `preview.legacy-loopback-route`), rewrite helpers in
`gateway-proxy.ts`, `gateway-support-extra.ts` and `gateway-auth.ts`, and
compatibility mode in `apps/web/src/components/browser/ServiceBrowserTab.tsx`.
Stored tabs that match exactly one service already convert (0042 D21).

**Investigation.** Not started. 0042 task 9 (the shared legacy partitions)
follows this task.

**Decisions.**

- **What happens to a stored legacy URL tab that matches no single service?**
  - **It stays a plain URL tab that opens externally (recommended; 0042 D21's
    plan).**
    - Pros: nothing is lost; no guessing at a service.
    - Cons: that tab loses in-app preview.
  - **Drop such tabs from the layout.**
    - Pros: no leftover tab kind.
    - Cons: removes something the user saved.

### 4. Retire mixed-version qualification

**Problem.** With every machine and client updated together, pairing today's
code with older releases proves nothing anyone runs, yet a weekly workflow
and several qualifiers still do it.

**Context.** The user's decision names
`.github/workflows/mixed-version-qualification.yml` and the mixed-version
scenarios. In the tree on 2026-11-14: `scripts/mixed-version/` (`harness.ts`,
`fixtures.ts`, `scenario.ts`, `scenarios/`), `scripts/qualify-contract-mixed-versions.ts`
(the `qualify:mixed-versions` mise task), `scripts/qualify-slash-mixed-versions.ts`,
`scripts/qualify-design-mixed-versions.ts`, `scripts/design-mixed-version-checks.ts`
and `scripts/older-release-stack.ts`. `scripts/mixed-version/scenarios/pipelines.ts`
is one of the callers of `import_legacy_build_pipelines`
([8109](8109-decided-removal-candidates.md) task 5). To-do 0015 (retired
2026-11-14) closed its mixed-version task under the same decision.

**Investigation.** Not started. Check every importer of
`older-release-stack.ts` and the mixed-version harness before deleting
(`scripts/qa-remote-goal-hold.ts` was seen referring to mixed versions), and
every doc that names the scripts, the task or the workflow
(`version-compatibility.md` "Checking a pairing live", the testing guide,
flake cases). `tests/unit/mise-tasks.test.ts` fails on a doc that names a
removed mise task.

**Decisions.**

- **How much goes?**
  - **The workflow, the scenarios, the qualifiers, their mise tasks and their
    docs; keep a script only if something other than mixed-version
    qualification imports it (recommended).**
    - Pros: matches the decision; no tooling left that nothing runs.
    - Cons: if the forward policy (below) later asks for older-version
      checks again, they are rebuilt from Git history.
  - **Keep the harness, delete only the workflow.**
    - Pros: cheap to revive.
    - Cons: unmaintained code that rots against current contracts.

### 5. Remove the paths task 1 leaves unowned

**Problem.** Whatever task 1 finds with no owning to-do stays in the tree.

**Context.** Each removal follows
[version-compatibility.md](../../architecture/version-compatibility.md):
remove the code and its tests, drop its counter name from
`compatibility-path-usage.ts`, and move its register row to Retired with the
date and "retired by the 2026-11-14 legacy-retirement decision".

**Investigation.** Depends on task 1.

**Decisions.**

- **One change or several?**
  - **A few changes grouped by area (backend and bridges, renderer, protocol
    adapters), each with its own validation (recommended).**
    - Pros: reviewable; one failing area does not hold the rest.
    - Cons: several pipelines.
  - **One change for everything.**
    - Pros: one validation run.
    - Cons: a very large diff across every package.

## Assumptions and decisions

### The sweep itself (user decision, 2026-11-14)

- **Decided by the user (maintainer) on 2026-11-14:** retire all legacy
  support now, everywhere in the repository; every machine and client is
  updated together. Waits on support-window dates or version floors no longer
  block any to-do. The same answer covers 7571 task 9 (task 2 here), 0042
  task 8 (task 3 here) and the mixed-version workflow and scenarios (task 4
  here).
- **Not decided:** whether future changes still need older-version adapters.
  This file records a one-time sweep only. The support-window policy text in
  [version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)
  is not rewritten; a note there records the sweep, and the forward policy is
  for the user to approve separately. Until then the contract tooling (the
  manifest, the ratchet and CI) stays as it is.

## Constraints and rationale

- Stored user data is not version skew (task 1's first decision).
- Every removal keeps the transport invariants in the root `AGENTS.md`; a
  removed fallback must not leave a missed event undetectable.

## Related

- [version-compatibility.md](../../architecture/version-compatibility.md): the
  register, its Retired table and the note on this sweep.
- [7571](7571-removal-candidates-needing-a-decision.md) task 9 and
  [0042](../previews-and-annotations/0042-service-preview-rollout.md) task 8:
  the decisions behind tasks 2 and 3.
- [8109](8109-decided-removal-candidates.md): the other removals the user
  decided on 2026-11-14.
- The unblocked to-dos listed under task 1.

## Replaces

Nothing; new work from the user's decision of 2026-11-14.
