# Ticket schema analysis: arktech-mini

What coordinators on arktech-mini actually wrote when they created or steered
work, as input for designing structured ticket types. The dataset is
[`arktech-mini.jsonl`](arktech-mini.jsonl), one record per extracted item.

## Corpus

- **Source.** All coordinator transcripts under
  `~/Library/Application Support/orkestrator-v2/coordinator-runtime/<coordinator>/conversations/<conversation>/claude-home/projects/**/*.jsonl`,
  including sub-agent files. Every coordinator on this machine ran on Claude.
  There are no Codex, Pi or other coordinator stores here. The files were
  opened read-only.
- **Coordinators.** 5 coordinators, 11 conversations, 2026-10-07 to 2026-10-27.
  One coordinator (`0b1c4cbc`, orkestrator-v2) wrote 281 of the 293 items. The
  others belong to angela-tools-3 (5), sd-squiggle-mono (5), tcm-app (1) and
  clarity-sound-studio (1). Treat the results as a profile of one heavy
  coordinator, not of coordinators in general.
- **Extracted.** 451 tool calls, after removing repeated `tool_use` IDs:
  - 178 `launch_environment`, 11 `launch_node_environment` and 19 `launch_job`
    (text from `prompt`);
  - 93 `send_message` (text from `body`);
  - 10 `start_build_pipeline` (text from `taskSnapshot.description` and
    `acceptanceCriteria`);
  - 8 `create_ticket` (text from `description`);
  - 132 `launch_multi_review`. These have no `reviewInstruction` field and carry
    no text, so they are not in the dataset.
  - There were no `update_ticket` or `send_prompt_to_tab` calls.
- **Dataset.** 319 records:
  - 20 are byte-identical resends, flagged with `duplicate_of`. 18 of them are
    one "Base your branch on latest origin/main" message sent to many workers.
  - 6 are acks or reports with no work requested, flagged with
    `delegating: false`.
  - That leaves **293 unique delegating items**. All statistics below use those
    293.
- **Privacy.** The dataset holds derived features, the title and a 200-character
  redacted excerpt. Emails, credential URLs, key-like tokens and `token=`/`password=`
  values are redacted. A scan of the output found no secrets.

## Method

- **Kind.** Rules first, then a manual review of every title and opening text,
  with overrides (`kind_basis` records which applied):
  - label prefixes `qualify-`, `fix-` and `refactor:`;
  - opening lines such as `## Feature`, `## Bug` and "Investigation only";
  - "implement … todo file", meaning the spec lives in `docs/todo`.

  Starting from the suggested list, I **added** these kinds:
  - `review-followup/pr-stage`: post-Multi-Review "verify the fix, renumber, open
    the PR, write the handoff". It is very common and very formulaic.
  - `qualification`: live-provider or real-stack evidence runs, where the
    deliverable is evidence rather than code.
  - `docs/planning`: writing or checking in docs or ticket plans.
  - `ack/report`: excluded.

  `todo-implementation` means the prompt defers to a `docs/todo/…` file as the
  spec and does not itself say whether the work is a bug, feature or refactor.
  The 2026-10-14 `fix:`/`refactor:`/`feat:` batch also points at spec files, but
  it is classified by its label, and `spec_by_reference` records the reference.
- **Headings.** Markdown `#` headings, bold lead-ins (`**Problem:**`, including
  bold-numbered list items), lines ending in a colon (`Ground rules:`) and
  `Part/Phase/Step N`. Text inside code fences is ignored.
- **Section types.** Two sources:
  - heading text mapped to a fixed vocabulary of 19 types (listed below);
  - content cues for sections that are often present without a heading, for
    example "first read …", numbered steps, reserved ID ranges, `mise run test`,
    "final message", or two or more file paths. Cues count as `code-pointers`.

  `section_sources` records whether each type came from a heading or a cue. The
  vocabulary: task-statement, problem, background, root-cause, decisions,
  requirements, design/ux, code-pointers, out-of-scope, constraints,
  safety-rules, open-questions, validation, acceptance-criteria,
  deliverables/reporting, references, steps, numbering-allocation and
  git/pr-workflow.
- **Boilerplate share.** The share of characters on lines that either appear,
  after normalising digits, hashes and backticks, in 3 or more distinct items,
  or match one of the 28 rule patterns below. This is a rough estimate. It
  undercounts paraphrased rules and slightly overcounts short shared lines.
- **Acceptance criteria.** The bullets under an `Acceptance criteria` / `Done
  when` heading or field. Quality was scored with a keyword heuristic (stored
  per record) and checked by reading every criterion.

## Counts by kind

| Kind | Items | % | Median chars | Median boilerplate | Spec by reference | With AC |
|---|---:|---:|---:|---:|---:|---:|
| todo-implementation | 112 | 38% | 2205 | 0.88 | 112 | 3 |
| review-followup/pr-stage | 38 | 13% | 1775 | 0.67 | 1 | 0 |
| qualification | 29 | 10% | 3332 | 0.87 | 28 | 0 |
| bug | 26 | 9% | 3555 | 0.61 | 18 | 2 |
| repair/rescue | 26 | 9% | 1065 | 0.42 | 4 | 0 |
| feature | 18 | 6% | 4889 | 0.15 | 8 | 5 |
| follow-up/steer | 17 | 6% | 1105 | 0.21 | 0 | 0 |
| research | 8 | 3% | 2112 | 0.18 | 0 | 0 |
| refactor | 6 | 2% | 1903 | 0.41 | 6 | 0 |
| operations/release | 6 | 2% | 3621 | 0.15 | 0 | 0 |
| investigate-then-fix | 4 | 1% | 3826 | 0.61 | 3 | 0 |
| docs/planning | 3 | 1% | 25574 | 0.03 | 3 | 0 |
| **total** | **293** | | 2182 | 0.65 | 183 | 10 |

By tool, median boilerplate share is:

| Tool | Median boilerplate |
|---|---:|
| `launch_job` | 0.92 |
| `launch_environment` | 0.87 |
| `launch_node_environment` | 0.87 |
| `send_message` | 0.43 |
| `start_build_pipeline` | 0.38 |
| `create_ticket` | 0.00 |

116 of the 293 items (40%) are at least 80% boilerplate.

The 26 `repair/rescue` items break down by cause:

| Cause | Items |
|---|---:|
| Multi Review Fix session failed (model at capacity, Codex restart, validation step) | 8 |
| Claude restarted on the remote host mid-turn | 8 |
| Build pipeline failed at Verify, or could not be resumed | 5 |
| Network outage, usage limit, or turn ended mid-step | 5 |

## Section types by kind

These are the percentages of items in each kind with the section type present,
from either a heading or a cue. Column key:

| Column | Section type |
|---|---|
| task | task-statement |
| prob | problem |
| bkgd | background |
| cause | root-cause |
| decis | decisions |
| reqs | requirements |
| ux | design/ux |
| code | code-pointers |
| oos | out-of-scope |
| cons | constraints |
| safe | safety-rules |
| openq | open-questions |
| valid | validation |
| AC | acceptance-criteria |
| report | deliverables/reporting |
| refs | references |
| steps | steps |
| nums | numbering-allocation |
| git | git/pr-workflow |

| Kind (n) | task | prob | bkgd | cause | decis | reqs | ux | code | oos | cons | safe | openq | valid | AC | report | refs | steps | nums | git |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| todo-implementation (112) | 16 | 39 | 29 | 0 | 91 | 5 | 8 | 97 | 2 | 78 | 24 | 0 | 97 | 3 | 96 | 72 | 81 | 39 | 88 |
| review-followup/pr-stage (38) | 0 | 0 | 3 | 0 | 0 | 3 | 0 | 18 | 0 | 3 | 13 | 0 | 92 | 0 | 92 | 0 | 100 | 47 | 92 |
| qualification (29) | 45 | 7 | 52 | 0 | 28 | 3 | 0 | 100 | 7 | 97 | 83 | 3 | 100 | 0 | 100 | 66 | 76 | 59 | 100 |
| bug (26) | 23 | 42 | 35 | 27 | 46 | 8 | 12 | 96 | 15 | 69 | 62 | 4 | 96 | 8 | 92 | 46 | 77 | 38 | 88 |
| repair/rescue (26) | 0 | 0 | 0 | 0 | 15 | 0 | 0 | 4 | 0 | 19 | 38 | 0 | 81 | 0 | 92 | 0 | 92 | 19 | 81 |
| feature (18) | 50 | 22 | 33 | 0 | 39 | 28 | 28 | 72 | 6 | 56 | 28 | 6 | 72 | 28 | 67 | 22 | 72 | 0 | 50 |
| follow-up/steer (17) | 6 | 0 | 0 | 0 | 0 | 18 | 12 | 29 | 0 | 6 | 12 | 0 | 53 | 0 | 53 | 0 | 35 | 0 | 53 |
| research (8) | 12 | 0 | 0 | 0 | 0 | 75 | 0 | 100 | 12 | 62 | 25 | 0 | 25 | 0 | 100 | 75 | 100 | 12 | 88 |
| refactor (6) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100 | 0 | 0 | 0 | 0 | 100 | 0 | 100 | 100 | 100 | 0 | 100 |
| operations/release (6) | 33 | 0 | 17 | 0 | 0 | 0 | 0 | 67 | 0 | 33 | 33 | 0 | 33 | 0 | 83 | 0 | 83 | 0 | 67 |
| investigate-then-fix (4) | 75 | 100 | 100 | 75 | 75 | 25 | 0 | 75 | 0 | 100 | 75 | 0 | 100 | 0 | 100 | 25 | 100 | 0 | 100 |
| docs/planning (3) | 33 | 0 | 67 | 0 | 67 | 100 | 67 | 100 | 0 | 67 | 67 | 67 | 100 | 0 | 100 | 0 | 100 | 0 | 100 |

What the table shows:

- **Every kind carries a done-contract.** Validation, deliverables/reporting and
  git/pr-workflow appear in 80–100% of items in almost every kind. They are the
  same few rules each time, and that is where the boilerplate is.
- **Task content is thin in the prompt itself.** In todo-implementation and
  qualification, only 16–52% of items have a task, problem or background
  section. The spec is a file reference instead: all 112 todo-implementation
  items and 28 of 29 qualification items point at a file.
- **Explicitly titled sections are rare.** 64 items (22%) have no heading at
  all. Root-cause appears only in bug and investigate-then-fix items (27% and
  75%). Out-of-scope appears in at most 15% of items in any kind, and
  open-questions is almost absent: the standing instruction is "decide
  yourself, record the decision".
- **Heading styles are mixed.** Items use bold lead-ins (136 items), "Label:"
  lines (127) and markdown headings (111). No coordinator used one consistent
  format.

## Repeated rules: candidates for AGENTS.md

These are counts of the 293 items containing each rule, matched by regex, so
paraphrases are included.

| Rule | Items |
|---|---:|
| Run format, lint and typecheck | 241 |
| The final message in this tab must use fixed sections | 198 |
| Update the todo file and its folder/index row; tick or mark it finished | 192 |
| Record each decision: options, choice, why, pros and cons | 190 |
| Mail the coordinator with branch, commit and results when done | 178 |
| Run the full `mise run test` | 166 |
| Do not push or open a PR; the coordinator runs Multi Review | 163 |
| Do not stop to ask; build your recommended option | 156 |
| Read AGENTS.md/CLAUDE.md (and `docs/README.md`) first | 149 |
| Fetch, rebase or merge the latest `origin/main` | 147 |
| Use only the reserved todo/flake ID ranges | 92 |
| Never invent evidence; record what still needs live proof | 88 |
| The host is loaded: re-run a timeout alone before treating it as real | 71 |
| Go back item by item and validate against code and tests at the end | 71 |
| Open the PR yourself with `gh pr create` | 70 |
| Keep lint clean, including React Compiler `set-state-in-effect` | 64 |
| Register real flakes in `docs/tests/flaky-tests` | 63 |
| First verify the work is still needed on current main | 52 |
| Live runs only in a disposable isolated profile | 49 |
| Don't run the backend or app on the real data dir, install services, or bind 34121/34122 | 37 |
| Keep the diff focused; keep shared-file edits minimal | 31 |
| Address every valid finding and explain rejections | 29 |
| Never log credentials, spend host refresh tokens or sign the user out | 28 |
| Commit trailer `Co-Authored-By: …` | 25 |
| Check for an existing PR before opening one | 23 |
| Never kill other environments' containers, processes or ports | 21 |
| Never leave uncommitted files in the worktree | 21 |

The final-message section names asked for in those 198 items:

| Section | Items |
|---|---:|
| Decisions | 173 |
| Problem | 163 |
| Solution | 152 |
| Context | 114 |
| Not done / needs live evidence | 113 |
| Tests run | 113 |
| What was done | 80 |
| Not qualified | 55 |
| PR link | 42 |
| Assumptions | 37 |
| Multi Review outcome | 27 |

This report shape is stable enough to become a schema field. The same goes for
"decision record = options, choice, why, pros and cons, cost of switching".

Prompts are also stamped from templates. 99 items fall into 8 template families
that share an identical opening; the largest families have 30, 20, 15, 10 and
10 members. Inside a family only the todo path, the reserved ID range and
occasionally one extra note change.

### What not to move into AGENTS.md

Some of the repeated text is per-batch, not static, so it should become ticket
or launch fields:

- reserved todo/flake ID ranges;
- the base commit;
- whether the worker or the coordinator opens the PR, which flips between
  batches (163 items say "don't push" and 70 say "`gh pr create`");
- host-state notes such as "Docker may hang", "port 1422 taken" or "host
  heavily loaded".

## Notable outliers

- **Content passed inline.** The two docs/planning items at 25–26k characters
  carry a whole todo document inside the prompt. One is a read-only "Side 2"
  coordinator mailing it to the main coordinator, and the other is the
  coordinator's launch prompt. Tickets need an attachment or body field, not a
  prompt.
- **A coordinator-designed ticket template.** The "PRD → ticket plan" item
  (17k, clarity-sound-studio) defines its own ticket format:
  - a metadata table with Milestone, Priority, Area, Requirements, Blocked by,
    Needed to close and Blocks;
  - Summary;
  - Scope, split into In and Out (with the out-of-scope items pointed at the
    ticket that owns them);
  - Implementation notes;
  - checkbox Acceptance criteria;
  - Deliverables.

  It is the clearest statement in the data of what a structured ticket should
  hold, and the only place that models dependencies.
- **Ticket and pipeline snapshot disagree.** Each `create_ticket` description
  is 116–409 characters ("Implement docs/todo/…md in full. Read it first; it
  is the spec."), while the `start_build_pipeline` snapshot for the same work
  is 2.5–8.7k characters. The worker gets text that is not on the Kanban ticket.
- **Broadcast steer.** One message, "Base your branch on latest origin/main",
  went to 20 workers that had been launched from a stale local main. This is
  the case for a base-commit field checked at launch.
- **Two-phase approval gate** (sd-squiggle-mono crop). Phase 1 ends with "then
  stop … until the coordinator tells you the user has approved", followed by 4
  steer messages carrying the user's choices. A `hold-for-approval` checkpoint
  would replace this prose.
- **Coordinator-to-coordinator relays.** Read-only "Side 1/Side 2"
  coordinators asked the main coordinator to launch work in 3 items, plus 2
  brief updates.
- **Operations.** A `launch_job` was used as a timer ("sleep 540 until 03:12,
  then mail the coordinator"), before scheduled jobs existed. There is also a
  319-character "workspace ready" launch with no task.
- **Smallest and largest:**
  - smallest: `create_ticket` one-liners (116 characters);
  - largest feature: release-channels (9.8k characters);
  - largest bug: build-pipeline restart rewind (6.3k characters).

## Acceptance criteria

- **AC are rare.** Only 10 of 293 items (3%) include them, with 89 criteria in
  total. All 10 came through `start_build_pipeline`, whose snapshot has an
  `acceptanceCriteria` field. No `launch_environment` prompt had an AC section.
  Instead, the done-definition is spread across validation commands, "update
  the todo/index" and the fixed final-message sections.
- **Heuristic score:** 54 checkable, 9 mixed and 26 vague. Reading them by hand,
  most are observable behaviour statements. The vague ones defer to a later
  judgement or to the worker's own decisions.
- **Checkable examples:**
  - "Typing part of a project name that exists only on a leaf machine (e.g.
    "tel" for telegram-scraper on mbp3) shows that project as a result,
    labelled with its machine."
  - "Restarting round 1's Verify on a pipeline whose round 4 Verify failed
    rewinds iteration to 1, reruns Verify 1, and on failure continues Fix 2 ->
    Verify 2 …"
  - "`commands-process-coverage` passes with the host's `XDG_STATE_HOME` set."
  - "'Can you find me some angels?' … leads to a `find_matches` call with an
    investor-type filter … The returned matches contain no funds."
- **Vague examples:**
  - "Works in the mobile layout."
  - "Selecting any other step still shows its transcript as before."
  - "A pipeline with no stored snapshot shows a sensible placeholder."
  - "The phase counter and progress bar behave as recorded in the decisions."
    This one is circular: the worker defines the criterion.
  - "Work is delivered as a pull request against main with a clear
    description."
- **Boilerplate criteria:**
  - "format:check, lint, typecheck and the full mise run test pass (or any
    failure is shown to be pre-existing and registered)" appears in 7 of the 9
    orkestrator-v2 tickets.
  - "One PR, with every decision recorded in its description" appears in 4.
  - "The todo's Assumptions and decisions section records each decision…"
    appears in 3.

  These belong in a per-project default done-contract, not in each ticket.

## Implications for structured ticket types

1. **Few kinds carry real task text.** Feature, bug, investigate-then-fix,
   research and docs/planning have bespoke content, and they are only 20% of
   items. The rest are pointers to a spec file plus a reused protocol, or
   lifecycle and steering messages.
2. **The fields that vary per item:**
   - a spec reference (file path) or an inline problem/background;
   - root cause, for bugs only;
   - decisions already taken by the user;
   - code pointers;
   - out of scope;
   - acceptance criteria;
   - reserved ID ranges;
   - base commit;
   - the PR policy (worker opens it, or coordinator via Multi Review);
   - live-evidence and qualification needs.
3. **What to move into the project's AGENTS.md:** the policy rules above (lint
   and test commands, no-ask/decide-and-record, never invent evidence, flaky
   registry, isolated profiles, credential safety, the loaded-host re-run rule)
   and the final-report template.
4. **What should be workflow states or actions, not ticket prose:**
   review-followup/pr-stage (13%) and repair/rescue (9%), plus the "base on
   latest main" broadcast. Examples are "resume after interruption" and "apply
   the Multi Review findings, then PR".
