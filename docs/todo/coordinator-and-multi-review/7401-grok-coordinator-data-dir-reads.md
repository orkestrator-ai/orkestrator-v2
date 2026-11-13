# Grok coordinator: keep its reading tools out of the data directory

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from
[6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3, which closed
the data directory on Pi and OpenCode but could not on Grok. Re-checked
2026-11-11 against `main` at `498b68766`: still true (the profile still leaves
Grok's reading tools, the bridge still has no path check on them); Grok is now
pinned at 1.0.77.

### Tasks

1. **Find whether Grok's reads ask permission**: extend the Grok probe so one signed-in run answers it (Grok's read, search and list tools under the read-only profile). Status: done (agent part, 2026-11-11: the probe's `data-dir-reads` variant, tested against a fake ACP agent). Running it signed in needs a Grok login and is on the manual-test checklist.
2. **Refuse data-directory reads where Grok asks**: add the path check to the bridge's permission answer for read calls, if task 1's probe run shows Grok asks; otherwise record the gap in Grok's policy note. Status: blocked (waits on 7568: 7401 task 1 probe run).

### 1. Find whether Grok's reads ask permission

**Problem.** A read-only Grok coordinator can read Orkestrator's data directory
(`control-mcp.json`, `config.json`, the database, every login). Its private
profile (`acp-readonly-profile.ts`) removes the writing and shell tools but
leaves Grok's reading tools, and the bridge has no path check on them.

**Context.** The ACP bridge's own `fs/read_text_file` is already confined to the
workspace (`secureExistingFile` in `acp-client-methods.ts`), so a read Grok
routes through the client cannot reach the data directory. The gap is Grok's
built-in reading tools, which run in the Grok process. The launcher names the
data directory in `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`; the shared
check is `@orkestrator/protocol/node/coordinator-read-boundary`.

**Investigation.** Grok 1.0.52 was observed not to ask before shell commands
(the reason for the profile); whether its reads ask is unobserved. Grok is
signed out on the qualifying hosts
(0024 (retired) task 1, now on the manual-test checklist), so no probe was run.

Done 2026-11-11: `scripts/coordinator-probes/grok-web-tools-probe.mjs` has a
`data-dir-reads` variant. It launches Grok exactly as the bridge launches a
coordinator (`--disable-web-search`, `agent --no-leader`, the read-only profile
with `monitor` removed, no `--always-approve`), plants a fixture data directory
beside the workspace (a `control-mcp.json` holding a random token, a
`config.json`, a database file, and a randomly named session file one level
down holding a search canary), advertises `fs/read_text_file` and serves it only
for workspace files (the bridge's confinement), and answers every
`session/request_permission` with `reject_once` (`policyDenialOutcome`). It asks
for a workspace read first (the control), then a read, a listing and a search
of the data directory, each step in its own ACP session. For each step it
records every permission request (kind, the paths it names, the answer), every
client read (path, served or refused), every tool call (kind, locations, final
status) and whether a canary reached the reply, and gives each data-directory
step an `outcome`: `asked`, `refusal-ignored`, `unasked-leak`, `unasked-tool`,
`client-confined` or `no-attempt`. It ends with a `summary` (including every
outcome) and a `finding` naming which branch of task 2 applies, built from all
three outcomes. Paths are printed as `<workspace>/…`, `<data-dir>/…`,
`<fixture>/…` or `<other>`, in titles as well as in structured fields, and
replies from the data directory are never printed.
`tests/unit/grok-coordinator-read-probe.test.ts` runs the variant against a
fake ACP agent in seven modes (mixed, fully mediated, unmediated, a refusal
ignored, client reads only, nothing attempted, and a failed control) and checks
every recorded field, each outcome and finding, the exit status, and that no
real path, out-of-fixture title path or canary is printed.

**Decisions.**

- **How to find out?**
  - **Extend the Grok probe to read a fixture data directory and record every `session/request_permission` and `fs/read_text_file` it sends (recommended; done).**
    - Pros: one run answers both whether reads ask and which path they name.
    - Cons: needs a Grok login, and each run is a billed turn.
  - **Assume reads never ask, and record the gap only.**
    - Pros: no login needed.
    - Cons: leaves a check that may be possible unbuilt.

### 2. Refuse data-directory reads where Grok asks

**Problem.** If Grok asks before a read, the bridge can refuse one that reaches
the data directory, the way it already refuses MCP calls with `reject_once`.

**Context.** Permission answers are built in `acp-session.ts`; a refusal ends
Grok's turn, which `POLICY_DENIAL_CONTINUATION` (`acp-prompt.ts`) resumes.

**Investigation.** Depends on task 1's signed-in run (on the manual-test
checklist). The probe's `finding` says which branch applies, from every
data-directory step's `outcome`: "reached the data directory without a
refusable permission request (steps)" (the recommended note; when other steps
did ask, the finding adds that a permission-answer check for those alone would
not close the gap), "asks before every data-directory read it attempted and
names the path" (build the check), or "routed … through fs/read_text_file"
(already confined; record it). A mixed run therefore needs the note, and the
check is worth building only as well as, not instead of, it.

**Decisions.**

- **What to do if reads never ask?**
  - **Leave Grok at the advisory tier and say in its note that it can read the data directory (recommended).**
    - Pros: honest; Grok is already advisory for the same reason on shell.
    - Cons: the gap stays.
  - **Route Grok's reads through `fs/read_text_file` only, if Grok offers a switch.**
    - Pros: the bridge's existing confinement would apply.
    - Cons: no such switch is known on 1.0.77.

## Assumptions and decisions

### Task 1: the probe's answer to a permission request

Chose `reject_once` (falling back to `cancelled` when Grok offers no reject
option), the answer the bridge's `policyDenialOutcome` gives, rather than the
older `cancelled` the web variants still send. The run must see what a real
coordinator sees: Grok 1.0.52 ends its turn on any answer except allow, and the
answer chosen can change whether Grok retries through another tool.

### Task 1: a separate variant, not a change to `coordinator`

Added `data-dir-reads` beside the existing `coordinator` variant instead of
changing it. `coordinator` answers a different question (which web tools the
launch leaves) and its output shape is what D8's evidence in
[`coordinator-read-only-decisions.md`](../../architecture/coordinator-read-only-decisions.md)
was recorded from; the new variant uses the same launch flags, so it measures
the same coordinator.

### Task 1: what is printed

Fixture paths are labelled and data-directory replies reduced to a
leaked/not-leaked flag, so the output a person pastes back contains no path
from their machine and nothing read from a data directory, even a fixture one.

### Task 1: one step's answer cannot decide the finding (review round 1)

The first version of the finding let any permission request naming the data
directory win, so a run where the read asked but the listing read without
asking recommended only the permission-answer check, which cannot stop the
listing. Each step now gets its own outcome and any step that reached the data
directory without a refusable request (no request naming it, or a refusal it
ignored, or a data-directory tool that ran unasked) makes the finding the
advisory note, naming the steps that asked alongside it. The alternative,
printing per-step outcomes with no finding, was not taken: the checklist asks a
person to paste one line back, and the outcomes are printed anyway.

### Task 1: steps cannot see each other's replies (review round 1)

Every step runs in its own ACP session, and the search target is a randomly
named file one directory down, which the listing step cannot reveal. Before
this, the search step shared a session with the listing and counted as leaked
on `config.json`, a name the listing had just returned, so a model that skipped
the search but repeated the name would have recorded a leak.

### Task 1: titles are labelled word by word (review round 1)

Tool and permission titles are written by the model and the provider. Every
word with a slash or backslash is labelled as a path is: fixture paths keep
their place, and anything else (another absolute path, `~/…`, a Windows path, a
URL, or a piece of a path split at a space) becomes `<other>`; canaries become
`<canary>`. This loses relative paths in titles, which the fixture workspace
does not need, in exchange for never printing a path from the person's machine.

## Related

- [6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3
- [coordinator-live-conformance.md](../../development/coordinator-live-conformance.md) (to-do 0024, retired)
- [`coordinator.md`](../../architecture/coordinator.md#provider-qualification): Grok's boundary.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: running the Grok probe signed in) moved there on 2026-11-10.
