# Self-improvement

Status: Living. Experimental and **off by default**. Turn it on in
Settings → Experimental → Self-improvement.

Self-improvement finds what to fix or improve from how this machine actually
behaves, files it as tickets on a project's board, and checks each fix on
the app versions that carry it. It looks in two places:

- **The app's own diagnostics.** The
  [essential event log](logging.md#the-essential-event-log), the
  [health summary](logging.md#health-summary-and-the-clean-exit-marker) and
  the database figures, built in process as a
  [diagnostics bundle](logging.md#the-diagnostics-bundle). These give
  crashes, errors, faults, slow queries and memory growth. Fixed rules rank
  them; no model is involved.
- **Conversations with agents** (optional). A model reads your Claude Code
  and Codex conversations to find friction rules cannot see: instructions
  you keep repeating, confusion, workarounds, mistakes you have to catch,
  missing features and slow or stuck work.

Diagnostics findings become `[improvement] …` tickets labelled `improvement`.
Conversation themes become `[insight] …` tickets labelled `insight`.

## Using it

1. **Turn it on.** Settings → Experimental → Self-improvement. While it is off,
   the tab is hidden, nothing runs (not even the daily run), and the commands
   refuse to start a run.
2. **Settings → Self-improvement:**
   - **Project for tickets.** The board that receives tickets. A run needs one.
   - **Review conversations.** On by default once the feature is on. Turn it
     off to use diagnostics only.
   - **Run daily.** Off by default. While the app runs, it runs once a day
     on its own.
   - **Preview.** Shows what a run would file. It files nothing, saves
     nothing and calls no model.
   - **Run now.** Starts a run in the background. The page shows its progress
     and keeps working if you close it.
3. **Work the tickets as usual.** A pipeline, a PR, a merge; the merge moves
   the ticket to Done.

Your controls are on the board:

| On the board | The next run |
| --- | --- |
| Move a ticket to Done | Marks it fixed, and checks the app versions released after that point |
| Move a Done ticket back out, even a confirmed one | Treats it as open again |
| Delete a ticket, even a confirmed one | Ignores that problem from now on (for noise you accept) |
| Nothing | Keeps watching. Nothing is filed twice |

A ticket stays on the project it was filed on. Choosing another project
sends new tickets there; the older ones are still read, commented on and
moved on their own board.

Once a newer version has been used long enough (a day for diagnostics, 10
conversations for an insight), a run judges each fix. A fix that worked is
**confirmed** with a comment on its ticket. If the problem is still there,
the run comments with the numbers and **moves the ticket back to the
backlog**.

The page also lists the last run's results, every tracked ticket with where
its fix stands, and the conversation themes.

From a terminal, with a default CLI connection
([public-cli.md](public-cli.md#selecting-a-backend)):

```bash
orkestrator self-improvement status
orkestrator self-improvement run [--dry-run] [--wait]
mise run improvement            # in this repository: run --wait
mise run improvement:preview    # run --dry-run --wait
mise run improvement:status
```

## What a run does

The run is `runLoop` in `apps/backend/src/core/self-improvement/loop.ts`; the
service around it is in `service.ts`. Its steps are those the page shows:

1. **Exporting.** Builds this backend's diagnostics bundle in memory
   (`buildDiagnosticsBundle`, redaction included) and reads it.
2. **Board.** For each tracked problem with a ticket, reads the ticket on
   the project it was filed on (the ledger entry's `projectId`) and applies
   the table above. Done records "fixed in any version newer than the one
   running now" (`fixedAfter`).
3. **Reading conversations** and **grouping themes**, when the review is on
   (see [Conversation review](#conversation-review)).
4. **Digesting.** Ranks every signal from the bundle and the themes, and
   judges each fix (see [Verdicts](#verdicts)).
5. **Filing.** Comments on judged tickets and moves failed ones back to the
   backlog. Then files new tickets:
   - **Diagnostics:** score of at least 50, roughly an error seen about once a
     day. At most 3 in any 24 hours.
   - **Insights:** a theme seen in two conversations, or in one that blocked
     the work. At most 2 in any 24 hours.

   An open ticket with the same title is linked rather than duplicated. The
   `improvement` and `insight` labels are created the first time they are
   needed.
6. Saves the digest and the run's summary.

The ledger is saved after the board is read and after every board change, so
a run that fails part-way keeps the tickets it filed and the verdicts it
posted: the next run neither files them again nor bypasses the daily limit.
A verdict comment carries a request id that stays the same across runs, so a
retry posts it once.

One run happens at a time. A run that fails records a fixed reason for the
step it was on ("Could not export this machine's diagnostics."), never the
error text.

## Conversation review

1. **Which conversations.**
   - Claude Code: `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and
     each Orkestrator-managed Claude account's `projects/` under the data
     directory.
   - Codex: `${CODEX_HOME:-~/.codex}/sessions`.

   Every project is read. A conversation is read once it has been quiet for
   an hour, and only its new part, so nothing is analysed twice. Where the
   last run stopped is a byte offset in the history file, so a history over
   24 MiB, read from its end, resumes correctly as it grows. The first run
   looks back 14 days. A run reads at most 30 parts; the rest wait for the
   next run. Conversations whose working directory is inside the data
   directory are never read. Finding the new parts reads every quiet history
   file of the last 14 days (thousands on a busy machine), so the scan yields
   to the backend's event loop every 20 ms rather than holding it for seconds.
2. **What is sent.**
   - Sent: your messages, the agents' replies (shortened), which tools ran
     (names and counts), tool errors and interruptions. Lines are marked as
     written by you, by another agent or by the system.
   - Never sent: tool inputs or outputs, file contents, or the agents'
     thinking.
   - Secrets are redacted (`redactSecrets`), and each part is capped at
     60,000 characters.
3. **Notes, with Sonnet 5.5.** Each part becomes friction notes. Each note
   says where it is best fixed: in Orkestrator, in the agent instructions
   (`AGENTS.md`, a skill or a prompt), or in the model itself. Bugs in the code
   being worked on are the task, not friction.
4. **Themes, with Opus 5.5.** The last 30 days of notes are grouped into
   themes, reusing a theme's name when it comes up again. Notes are saved
   before grouping; if grouping fails, the next run groups them again
   (`pendingGrouping` in `themes.json`) without reading the conversations
   again, and no insight fix is judged until it succeeds.
5. **Verification.** A theme's measure is **the share of conversations read
   that show it**, per app version, so a quiet week cannot pass for a fix.
   Only conversations a model actually reviewed count. One with nothing but
   system messages is skipped, and is no evidence either way.

**How it runs.** Through Claude Code in print mode, using the Claude binary
Orkestrator resolves and the account it has active, so it uses that plan's
limits rather than an API key. Each call:

- has no tools, no MCP servers, no slash commands, no settings files and no
  saved session;
- runs in the state directory, so no project instructions load and the review
  never reads its own calls;
- is aborted when the backend stops.

The provider is Anthropic, so Codex conversations are sent to Anthropic too.
If Claude Code is missing, the run says so once and carries on with
diagnostics.

**Cost.** Measured on a synthetic conversation: a notes call took 6 s and
$0.016, and a themes call 10 s and $0.04, at list prices. A run of 30 real
parts costs well under $2. The run summary shows each run's list-price cost.

## Signals and scores

Each signal has a stable **signature**, so the same problem matches across
runs. Ids of environments, sessions and processes are left out on purpose:

| Source | Signature | Example |
| --- | --- | --- |
| Essential log | `area:event[:provider][:kind]` | `storage:snapshot.failed:ENOSPC` |
| Bridge exits | `local-server:bridge.exited:<provider>:<signal or code-N>` | `local-server:bridge.exited:codex:SIGKILL` |
| Throttled faults | the site's signature, counting `throttle.suppressed` | `tmux:poll.snapshot-failed:EACCES` |
| Renderer failures | `renderer-errors:<class>:<boundary>:<fingerprint>` | `renderer-errors:TypeError:message-row:0badf00d` |
| A process that died | `logging:writer-died:<owner>` | `logging:writer-died:desktop` |
| Health rows | `backend:crashed`, `backend:rss-growth`, `backend:rss-peak`, `backend:cpu`, `backend:event-loop-stalls`, `recurring:<kind>:failed`, `recurring:<kind>:busy` | `recurring:git-scan:failed` |
| Database | `storage:slow:<db>:<op>:<table>`, `storage:lease-timeout:<family>`, `storage:lease-wait:<family>`, `storage:busy`, `storage:wal-large` | `storage:slow:main:select:sessions` |
| Conversation themes | `insight:<theme>` | `insight:use-mise-not-npm` |

Each signal's category has a weight:

| Category | Weight | What falls in it |
| --- | --- | --- |
| `crash` | 100 | Backend crash or kill, uncaught exception, unhandled rejection, desktop writer death |
| `data` | 90 | Migration failure, snapshot integrity failure |
| `error` | 40 | Any `error` line; unrequested bridge exits, lost writer leases and failed session resumes |
| `fault` | 30 | Recurring job failures, lease timeouts, `SQLITE_BUSY` |
| `insight` | 30 | Conversation themes, ranked also by their severity |
| `performance` | 20 | Stalls, slow SQLite operations, long lease waits |
| `resource` | 15 | Memory growth or peak, CPU, busy recurring jobs, a large WAL |
| `warning` | 8 | Other `warn` lines |

The score is `weight × (1 + log10(1 + per day)) × (1 + min(active days, 7) / 7)`.

A signal's **measure** is a rate (occurrences per day over what its source
covers; for an insight, the share of conversations), or a gauge (the worst
value, such as MiB per hour of growth).

## Verdicts

A fix is judged only on the app versions that carry it:

| Verdict | Meaning | What the run does |
| --- | --- | --- |
| `awaiting-deploy` | No version carrying the fix has run yet | Waits |
| `awaiting-evidence` | Watched for less than 24 hours (10 conversations for an insight) | Waits |
| `improved` | At or below 20% of the baseline | Confirms it and comments |
| `partly-improved` | Between 20% and 80% | Lists it on the page: your call |
| `unchanged` | 80% of the baseline or more | Comments and moves the ticket back to the backlog |
| `holding` | Confirmed, still at or below 50% | Nothing |
| `regressed` | Confirmed, now above 50% | Comments and moves the ticket back to the backlog |

The baseline is the measure in the run that filed the ticket. If a ticket
goes to Done after you are already running the release that carries the
fix, the run waits for the next release before judging it.

## Where things live

| Thing | Where |
| --- | --- |
| Settings and status shapes, models and limits | `packages/protocol/src/self-improvement.ts` |
| Commands `get_self_improvement_status`, `run_self_improvement` | `system` domain (`access: admin`), `packages/protocol/src/contract/domains/system/commands.ts`; handlers in `apps/backend/src/core/commands-registry-self-improvement.ts` |
| Public actions `self-improvement.status`, `self-improvement.run` | `apps/backend/src/core/public-api/actions-self-improvement.ts`; CLI in `packages/cli/src/client/commands/self-improvement.ts` |
| Service and run | `apps/backend/src/core/self-improvement/` (`service.ts`, `loop.ts`, `signals.ts`, `ledger.ts`, `bundle.ts`, `report.ts`, `insights/`) |
| Settings page | `apps/web/src/components/settings/SelfImprovementSettings.tsx`, `SelfImprovementLists.tsx` |
| Config | `global.experimentalSelfImprovement`, `global.selfImprovement` (`projectId`, `conversationReview`, `dailyRun`) |
| State | `<data dir>/self-improvement/`, owner-only: `ledger.json`, `digests/` (newest 120, as `.json` and `.md`), `last-run.json`, `last-counted-run.json`, and `insights/` (notes for 90 days, at most 3,000; themes; read positions) |

## Rules

- **Experimental gate.** With `experimentalSelfImprovement` off, nothing runs:
  `run` refuses with `disabled` (the public action with
  `capability-unavailable`), and the daily check does nothing.
- **The backend owns runs.** The page only reads status. Closing it never
  stops a run, and reopening it shows where the run is.
- **One run at a time.** A second start is refused (`already-running`, or
  `busy` for the public action).
- **One backend per data directory.** Runs need the registry writer lease,
  as scheduled jobs do: a second backend sharing the data directory never
  starts one, daily or manual (`not-writer`), because the ledger, notes and
  read positions are shared files.
- **Stop is explicit** (invariant 15). `stop()` clears the daily timer, aborts
  model calls in flight, waits up to 5 seconds for the run, and refuses new
  runs. The backend calls it during shutdown.
- **Refuse before admission.** The public run action checks the switch, the
  project and a running run before its request key is admitted, so a refused
  run leaves no record. Its receipt says only whether it started.
- **Content-free logs.** The `self-improvement` log area holds triggers,
  steps, counts and fixed labels. Errors are logged by name and code without
  their message, which can quote a path. Notes and themes (paraphrases and short
  quotes of your own words) stay in the state directory and the tickets you
  asked for.

## Limits

- **Where, not why.** The essential log holds event names and fixed labels
  only. A ticket asks for a reproduction before a fix.
- **Rate-limited counts.** The essential log keeps 10 entries per event and
  then one per 10 minutes.
- **Windows differ by source.** The essential log reaches back as far as its
  4 MiB holds, the health rows seven days, database counters only this
  backend's run.
- **Container bridges are missing** from the bundle a run reads. Only the
  Export dialog adds container server logs, per environment, when the user
  opts in ([logging.md](logging.md)).
- **A model only sees what was said.** UI friction you never mention to an
  agent does not reach it. Themes are judgements: delete a wrong one's
  ticket.
- **Only Claude Code and Codex conversations** are read. OpenCode, Cursor,
  Grok and Pi keep theirs in other formats.
- **This machine only.** It runs on the machine the window runs on and reads
  that machine's diagnostics and conversations.

## Changing it

- New signal sources go in `signals.ts`, with a case in `signals.test.ts`.
  `bundle-contract.test.ts` builds a bundle with the backend's own builder
  and fails when its layout changes under the reader.
- `loop.test.ts` and `insights/analyze.test.ts` drive whole runs against a
  fake board (`testing/fake-board.ts`, which can fail a chosen call) and a
  fake model. `service.test.ts` covers the gate, the writer lease, the
  background run, the daily run and stop.
  `commands-registry-self-improvement.test.ts` covers the board over real
  Kanban storage, `public-api/public-api-self-improvement.test.ts` the public
  actions and `packages/cli/tests/self-improvement-command.test.ts` the CLI's
  `--wait`.
- When you change a prompt or schema in `insights/analyze.ts`, also run one
  real call: real models can refuse a schema a fake accepts.
- A signature format change orphans existing ledger entries. Avoid it, or
  migrate `ledger.json` in the same change.
