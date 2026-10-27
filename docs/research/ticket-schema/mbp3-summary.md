# Ticket schema analysis: mbp3

Analysis only. This is the mbp3 half of a two-machine dataset; arktech-mini is analysed separately in the same format. The dataset is `mbp3.jsonl` (186 records, one JSON object per line).

## Sources and scope

| Corpus | Records | Source |
|---|---|---|
| `coordinator` | 26 | Tool-use inputs written by coordinators hosted on mbp3. 23 come from Claude transcripts (`coordinator-runtime/<coord>/conversations/<conv>/claude-home/projects/*/*.jsonl`, `tool_use` blocks) and 3 from Codex rollouts (`codex-home/sessions/**/rollout-*.jsonl`, `item_completed` → `McpToolCall`). |
| `kanban` | 160 | Kanban tickets in the app store (`orkestrator.sqlite`, store `kanban`, read from a copy in /tmp). The store does not record who wrote a ticket. No coordinator transcript on mbp3 contains a `create_ticket` or `update_ticket` call, so most of these were probably written by the user or by build pipelines. They are kept as a separate corpus because they are the real ticket shape on this machine. |

Coordinator records by tool: `launch_environment` 18, `send_message` 8. None of the transcripts contain `launch_node_environment`, `launch_job`, `start_build_pipeline`, `create_ticket`, `update_ticket` or `send_prompt_to_tab`.

Excluded:
- 12 `launch_multi_review` calls, because none set `reviewInstruction`.
- 1 plain status acknowledgement `send_message`.
- 1 empty mail-store message.
- Duplicates. The same `tool_use` id appears in several Claude session files (resumed or forked sessions), and one launch was retried with identical input. These were removed by hashing tool name plus arguments.

Coverage limits:
- 13 coordinators exist on mbp3 but only 4 have any transcript left: 3 Claude coordinators (ark-stack, myscreencam, orkestrator-v2) and 1 Codex coordinator with 2 rollouts. 9 Codex coordinators kept only `logs_2.sqlite`, and those logs record MCP start-up events, not tool arguments.
- The myscreencam coordinator never delegated anything.
- 22 of the 26 coordinator items come from one orkestrator-v2 coordinator (`c40254ab`) over about 5 days. Treat the coordinator corpus as qualitative.
- Prompts that arktech-mini's coordinator delegated to mbp3 workers are left out. They exist in worker transcripts here, but arktech-mini's own dataset already covers them.

## Method

- **Kind.** Every coordinator item and every kanban ticket was classified by hand after reading it. The script only assigns `origin_pattern` (the shape of the text). Each record's `classification_method` says which method was used.
- **Kinds added to the starting list:**
  - `composite`: one prompt with several separate parts, each of which may become its own PR.
  - `docs/process`: a docs-only change that codifies rules.
  - `hardening`: security, reliability or performance remediation from an audit plan.
  - `ui-polish`: a small visual tweak.
  - `chore/tooling`
  - `content/config`: a data or link change.
  - `stub`: a ticket with a title only.
- **Kinds merged or unused.** `bug` and `investigate-then-fix` stay separate, because coordinators write investigate-then-fix (hypothesis flagged as unverified, root cause required). Kanban bug tickets just describe a symptom. `repair/rescue` and `refactor` had no coordinator examples on mbp3.
- **Sections.** Headings were detected from markdown `#`, `**bold**` lead-ins, `Label:` lines, `Part/Phase N`, user-story `AS A / I WANT / SO THAT`, and `AC-NN`. Each one was mapped to the normalised vocabulary.
  - Most text has no headings. Section types are also inferred from content cues, and `section_type_evidence` marks each one as `heading`, `cue`, `field`, `inline-in-description` or `manual`.
  - Only 47 of 233 coordinator sections and 190 of 458 kanban sections were announced by a heading.
  - Cue detection is regex-based, so treat percentages under about 15% as noise.
- **Section types added to the starting vocabulary:**
  - `goal`
  - `user-story`
  - `authorization`: the user has approved merge, release and similar actions.
  - `escalation/hitl`: how to hand a human-input request back.
  - `git-workflow`: commit, push, PR and merge policy.
  - `priority`: what to do first.
  - `evidence-integrity`: do not fake evidence; verify the root cause.
  - `acceptance-criteria`
  - `sizing/phase`: plan phase plus a T-shirt size.
- **Boilerplate.** `boilerplate_share` is the share of characters in sentences whose normalised form appears in 3 or more items of the same corpus. `boilerplate_share_rules_incl_paraphrase` also counts sentences that match one of 20 policy-rule regexes, which catches reworded copies of the same rule. `task_specific_share` is 1 minus the latter.
- **Acceptance criteria.** Taken from the ticket `acceptanceCriteria` field, or from an `Acceptance criteria:` block inside the description, then split into items. Each item is classed as:
  - command/test-verifiable: names a command, test or grep;
  - vague: subjective wording with no concrete anchor;
  - observable-behaviour: everything else.
- **Privacy.** Excerpts are at most 190 characters. Redacted before writing: URL paths, emails, UUIDs, SHAs, wallet addresses, long tokens, and `key=value` secrets.

## Counts by kind

### Coordinator corpus

| kind | n | median chars | median lines | mean boilerplate share (exact / incl. paraphrased rules) | with AC |
|---|---|---|---|---|---|
| todo-implementation | 10 | 1718 | 11 | 0.73 / 0.79 | 0 |
| follow-up/steer | 8 | 1060 | 5 | 0.00 / 0.32 | 0 |
| operations/release | 3 | 1320 | 1 | 0.00 / 0.55 | 0 |
| feature | 2 | 4258 | 27 | 0.00 / 0.13 | 0 |
| docs/process | 1 | 3534 | 15 | 0.00 / 0.24 | 0 |
| composite | 1 | 4880 | 24 | 0.00 / 0.07 | 0 |
| investigate-then-fix | 1 | 1541 | 1 | 0.00 / 0.43 | 0 |

Follow-up/steer messages break down by origin pattern:
- scope change: 2
- process-rule injection: 2. These are new user rules passed on mid-task.
- context injection: 2. These are facts or gotchas the worker might not know.
- evidence injection: 1
- unblock/redirect: 1

### Kanban corpus

| kind | n | median chars | median lines | mean boilerplate share (exact / incl. paraphrased rules) | with AC |
|---|---|---|---|---|---|
| feature | 77 | 563 | 5 | 0.01 / 0.01 | 39 |
| bug | 27 | 379 | 5 | 0.00 / 0.00 | 15 |
| hardening | 19 | 881 | 13 | 0.23 / 0.27 | 19 |
| ui-polish | 13 | 380 | 5 | 0.01 / 0.01 | 6 |
| refactor | 11 | 823 | 13 | 0.21 / 0.21 | 11 |
| chore/tooling | 7 | 537 | 12 | 0.14 / 0.15 | 4 |
| stub | 3 | 22 | 2 | 0.00 / 0.00 | 0 |
| content/config | 2 | 300 | 5 | 0.00 / 0.00 | 2 |
| research | 1 | 137 | 2 | 0.00 / 0.00 | 0 |

Kanban tickets by origin pattern:
- short request (one or two prose paragraphs): 101
- audit-plan backlog (`[phase.n] Title (size)`, with `Phase N —`, file:line pointers, `Source:` and a checklist): 35
- long spec (over 800 characters): 15
- feature-build summary (`Feature summary:` plus `Implementation instruction:`): 4
- title only: 3
- user story (`AS A / I WANT / SO THAT` plus `AC-NN`): 2

## Section-type frequency by kind (% of items)

Abbreviations:
- goal = goal; story = user-story; prob = problem; bg = background; rc = root-cause; dec = decisions
- req = requirements; ux = design/ux; code = code-pointers; oos = out-of-scope; cons = constraints; oq = open-questions
- val = validation; rep = deliverables/reporting; ref = references; steps = steps; num = numbering-allocations; safe = safety-rules
- auth = authorization; hitl = escalation/hitl; git = git-workflow; prio = priority; evid = evidence-integrity
- AC = acceptance-criteria; phase = sizing/phase

### Coordinator

| kind (n) | goal | prob | bg | rc | dec | req | ux | code | oos | cons | val | rep | ref | steps | safe | auth | hitl | git | prio | evid |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| todo-implementation (10) | 100 | 0 | 0 | 0 | 100 | 100 | 0 | 10 | 0 | 100 | 100 | 100 | 100 | 100 | 10 | 0 | 100 | 100 | 20 | 100 |
| follow-up/steer (8) | 0 | 12 | 38 | 0 | 0 | 0 | 0 | 25 | 0 | 75 | 0 | 62 | 50 | 50 | 12 | 25 | 62 | 38 | 0 | 0 |
| operations/release (3) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 67 | 100 | 67 | 100 | 100 | 33 | 67 | 33 | 67 | 100 | 0 | 33 |
| feature (2) | 50 | 100 | 100 | 0 | 100 | 100 | 0 | 100 | 50 | 100 | 100 | 100 | 100 | 50 | 100 | 0 | 50 | 100 | 50 | 0 |
| docs/process (1) | 0 | 0 | 100 | 0 | 0 | 100 | 0 | 0 | 100 | 100 | 0 | 100 | 100 | 100 | 0 | 0 | 100 | 100 | 0 | 0 |
| composite (1) | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 0 | 0 | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 100 | 100 | 100 | 0 |
| investigate-then-fix (1) | 0 | 100 | 0 | 100 | 0 | 0 | 0 | 100 | 100 | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 0 | 100 | 0 | 100 |
| **all (26)** | **46** | **19** | **27** | **8** | **50** | **54** | **4** | **23** | **19** | **92** | **62** | **88** | **85** | **65** | **23** | **12** | **77** | **81** | **15** | **46** |

The todo-implementation row comes almost entirely from one shared template, so its 100% columns are template slots, not independent choices. user-story, open-questions, numbering-allocations, acceptance-criteria and sizing/phase never occur in coordinator text.

### Kanban

| kind (n) | goal | story | prob | bg | rc | dec | req | ux | code | oos | cons | oq | val | rep | ref | steps | num | safe | git | prio | AC | phase |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| feature (77) | 5 | 5 | 25 | 18 | 0 | 1 | 71 | 31 | 1 | 3 | 14 | 1 | 6 | 3 | 4 | 5 | 1 | 1 | 8 | 4 | 51 | 1 |
| bug (27) | 0 | 0 | 56 | 0 | 7 | 0 | 30 | 33 | 0 | 0 | 4 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 56 | 0 |
| hardening (19) | 0 | 0 | 47 | 0 | 0 | 0 | 5 | 0 | 84 | 0 | 5 | 0 | 100 | 0 | 100 | 0 | 0 | 0 | 0 | 0 | 100 | 100 |
| ui-polish (13) | 0 | 0 | 23 | 8 | 0 | 0 | 15 | 23 | 8 | 0 | 0 | 0 | 8 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 46 | 8 |
| refactor (11) | 0 | 0 | 18 | 0 | 0 | 0 | 0 | 27 | 73 | 0 | 0 | 9 | 100 | 0 | 91 | 9 | 0 | 0 | 0 | 0 | 100 | 91 |
| chore/tooling (7) | 0 | 0 | 14 | 0 | 0 | 0 | 14 | 0 | 57 | 0 | 0 | 0 | 57 | 0 | 57 | 0 | 0 | 0 | 0 | 0 | 57 | 57 |
| stub (3) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| content/config (2) | 0 | 0 | 0 | 0 | 0 | 0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 50 | 0 | 0 | 0 | 0 | 0 | 100 | 0 |
| research (1) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **all (160)** | **2** | **2** | **31** | **9** | **1** | **1** | **43** | **24** | **19** | **1** | **8** | **1** | **25** | **1** | **24** | **3** | **1** | **1** | **4** | **2** | **60** | **22** |

The two corpora are almost mirror images:
- **Kanban tickets** describe what to build. About 60% have acceptance criteria. They almost never say how to work: constraints 8%, git-workflow 4%, reporting 1%, escalation 0%.
- **Coordinator prompts** are mostly about how to work: constraints 92%, reporting 88%, git-workflow 81%, escalation 77%. None has an acceptance-criteria section.

## Repeated rules (candidates for AGENTS.md)

These are counted across the 26 coordinator items, paraphrases included.

| count | rule | notes |
|---|---|---|
| 22 | Send the coordinator a completion mail or one final report (with a named list of fields) | The fields differ per kind. The rule itself is generic. |
| 15 | Read AGENTS.md and follow repo conventions | |
| 13 | Run the relevant typecheck/lint/test commands and keep them green | |
| 12 | Pick a sensible option and keep going; don't stop to ask (or "user authorised, no reconfirmation") | |
| 10 | Commit on the environment branch; do not push or open a PR | Opposite policy in 6 other items (open a PR, don't merge). Merge policy should be a ticket field, not boilerplate. |
| 10 | Don't fake or claim evidence for parts that need credentials, machines or platforms you don't have; leave them open and say so | |
| 10 | Update the todo doc and index with what is done and what remains | todo-implementation only |
| 10 | End the turn with a final `## Decision record` message, written for Multi Review reviewers | |
| 7 | Human input needed: `send_message` to the coordinator and end the turn straight away | |
| 6 | Bounded polls only; never use `--watch` or any wait without a time limit | Added after a worker hung on CI. |
| 6 | Do not merge | |
| 6 | Report the exact blocker rather than working around it | |
| 4 | Open a PR but don't wait for CI | |
| 4 | Scope guard: no unrelated fixes or changes | |
| 4 | The user has authorised merge/release; don't reconfirm | |
| 4 | Use the named skill (bun-testing, flaky-test-tracking, release skill) | |
| 3 | Mail sent mid-turn is held until the turn ends, so send and end the turn | This explains the human-input rule. It is platform behaviour and belongs in system docs. |
| 2 | No force push and no bypassing of branch protection or failing checks | |
| 2 | Do repository work in the worker, not the read-only coordinator | |
| 1 | Never print the token | |

In the kanban corpus the only boilerplate is the generic AC checklist: `` `bun run lint` passes ``, `` `bun run typecheck` passes `` and `` `bun run test` passes `` each appear on 35 tickets (all dd-play-bot audit items). That is 105 of the 469 kanban AC items (22%).

Recommendation from the data:
- **Move to AGENTS.md or the worker system prompt** (the same everywhere):
  - read AGENTS.md;
  - run checks;
  - don't fake evidence;
  - pick-and-continue with a decision record;
  - send-and-end-turn for human input;
  - bounded waits;
  - no force push or bypass;
  - scope guard.
- **Make into ticket fields**, because they vary per ticket:
  - delivery policy: `commit-only` / `open-pr` / `merge`, plus `waitForCi: bool`;
  - authorisations granted;
  - report fields;
  - whether a decision record or Multi Review follows.

## Notable outliers

- `c40254ab-401dfc55` "! commands + interactive prompt notifications" (4880 characters).
  - It is the only `composite` item: Parts A, B and C, with C an urgent bug.
  - It carries a timestamped incident narrative with environment ids, permission to split into several PRs, and a request to repeat the final report in the transcript because mail delivery was broken.
  - Only 23 seconds after the launch, follow-up `f0bed83e` sent the same worker more evidence and a second requirement, so the coordinator wrote one ticket as two messages.
- `c40254ab-73726f3d` "Load skills in coordinators" (4621 characters) is the most structured item:
  - sections: Goal, Why, Where to start (file:line pointers), Constraints and design guidance, Testing, Process rules, Final report;
  - a security checklist, with an instruction to report rather than ship any check that can't be closed.
- The 10 todo-implementation launches were sent within 52 seconds of each other. They share about 79% of their text; the only task-specific part is one "Goal:" sentence (median about 350 characters).
- Two Codex release prompts relay the user's request verbatim in quotes, then add authorisation and scope guards, and leave the worker to discover the release process. Both are one paragraph with no line breaks.
- The release worker on 2026-10-26 received 6 `send_message` steers in 28 minutes (13:23–13:51): scope widened, Linux build added, unblock, publish rules, skill gotchas, npm-login routing. At 13:37, while the release was still running, the coordinator launched a docs/process ticket to write those rules into the release skill. Rules that keep arriving as steers are candidates for persistent docs.
- Kanban extremes:
  - `kanban-77f52ea2` "Structured and looped code reviews" is 12,179 characters (feature-build summary);
  - 3 tickets are title-only stubs;
  - `kanban-d7a71220` "agent tools" is 75 characters in total.

## How acceptance criteria are phrased

- **Coordinator items: 0 of 26 have acceptance criteria.** The definition of done is spread across other signals:
  - a "Report back:" field list (13);
  - named verification commands, e.g. `--dry-run` or `mise run check` (13);
  - a decision-record message (10);
  - "add or update tests" (10).
- **Kanban: 96 of 160 tickets have AC**, 93 from the field and 3 inline in the description. That is 469 items, median 4 per ticket.
  - **Styles:** checklist `- [ ]` 35 (all audit-plan items), given-when-then 34, bullets 14, prose 10, `AC-NN` numbered 3.
  - **Checkability:** 130 items (28%) are command/test-verifiable, 333 (71%) are observable-behaviour statements, and 6 (1%) are vague.
  - **Coverage by origin:** audit-plan backlog 35/35 and feature-build summaries 4/4 have AC. Short requests have AC only 45/101 of the time.
  - **By project:** dd-play-bot 37/45 and vulkanglass 12/26 have AC; orkestrator-v2 25/53.
- **Checkable examples:**
  - "each route's test gains a 429 case; confirm limits are keyed per user, not global."
  - "grep confirms zero remaining direct `auth.api.getSession` calls outside `getServerSession`…"
  - "On macOS, get_system_usage reports a non-null GPU percent derived from IOAccelerator PerformanceStatistics…"
  - "Given the user right-clicks on a folder and selects 'Rename'…, a box should pop up asking for the new name."
- **Vague examples:**
  - "The toolbar clearly distinguishes Code Review from Looped Code Review."
  - "Invalid, expired, or already-used link codes return an appropriate response."
  - "Mention filtering handles Discord user mentions correctly."
  - "Table rendering style is consistent with Telegram output."
- **Weaker given-when-then items** restate the request rather than adding a test. For example: "I copy some markdown… In the app I paste using cmd+v… Then the text I copied should be pasted into the active editor."
- **Generic items:** 22% of AC items are the lint/typecheck/test checklist, which is policy rather than criteria. A schema should keep these in a standard "checks" field so the AC list stays task-specific.

## Implications for ticket types (from mbp3 only)

1. Coordinator prompts and kanban tickets cover opposite halves of a ticket. A structured ticket needs both:
   - task content: problem/goal, requirements, AC, code pointers, out of scope;
   - an execution contract: delivery policy, authorisations, escalation route, report fields, review follow-up.
2. Steering messages are a first-class type. 8 of 26 coordinator items are steers: scope change, rule injection, context or evidence injection, and unblocking. A `follow-up` ticket type that links to its parent and states a delta (added, removed or changed scope) would cover them.
3. `investigate-then-fix` needs fields that a bug ticket lacks: reproduction command, hypothesis (marked unverified), "verify root cause before fixing", and coverage to preserve.
4. `operations/release` items are mostly authorisation, guard rails and report fields, with little task content. They suit a runbook-reference type (runbook link + authorised actions + stop conditions).
5. Only 20% of detected coordinator sections and 41% of kanban sections had an explicit heading (the kanban figure is mostly the "Acceptance criteria" label). Structure today lives in prose, so fixed fields would add real information rather than just reformatting what is already there.
