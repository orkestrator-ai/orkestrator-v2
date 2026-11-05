# Automatic account switching: live checks

## Task analysis

Analysed 2026-11-01 against the branch built from `main` at `93b99bfba`, and task 9
on 2026-11-04 against `main` at `96ee1eb3e`, and tasks 3 and 10 on 2026-11-05 against
`main` at `414a89c0a`. How it works is in
[agent-accounts.md](../../architecture/agent-accounts.md#automatic-switching).

The feature is built and tested on fake accounts and readings, and on real bridges
and the pinned CLIs against scripted provider servers (`mise run verify:accounts:resend-live`).
Nothing here has met a real account running out: that needs an exhausted subscription,
and the build that added it was not allowed billed turns or real logins. Each task
needs a real provider, so none can run in CI.

### Tasks

1. **A real Claude weekly refusal**: the refusal's words reach the turn's error, a forced read shows `seven_day` at 100%, and the machine moves. Status: open; needs a Claude account at its weekly limit.
2. **A real Codex weekly refusal**: the same for Codex, and which slot holds the week on a real account. Status: open; needs a Codex account at its weekly limit.
3. **A real model-specific refusal stays stopped**: a Fable refusal moves nothing and resends nothing. Status: open; needs an account at that limit with room on the general limits.
4. **How soon a reading shows 100%**: whether the usage endpoint can still say under 100% just after the refusal. Status: open; decides whether a confirmed stop needs a second look.
5. **The resend against a real provider**: the conversation continues on the new account in a real turn. Status: open; billed. The bridge replacement and shared transcript are proven offline on both pinned CLIs, for all four kinds of work.
6. **Paid-overage fields on real accounts**: Claude's `extra_usage` on the OAuth usage endpoint; Codex's `credits` and `rate_limit.limit_reached` on the HTTP one. Status: open.
7. **Two machines**: the ticks reach a leaf by email, a pin on the leaf, a notice from a leaf's switch reaching the command node's coordinator, and an older leaf. Status: open; joins the two-machine batch in [0722](0722-per-machine-agent-accounts.md).
8. **The cost of a coordinator's notice**: each notice wakes a main coordinator for a turn. Status: open; decide after watching a real week.
9. **The flapping stops on rkmbp**: no more `soonest-reset` moves between the host login and its twin once the fix runs there. Status: open; needs the fixed build running on rkmbp with the tick on.
10. **A real 5-hour limit, there and back**: a real 5-hour refusal moves the machine and resends, and the machine returns when that limit resets. Status: open; needs a real 5-hour limit with the tick on and a second login.

### 1. A real Claude weekly refusal

**Problem.** The whole path after a Claude limit rests on what its result message holds at that moment, and no fixture was recorded from a real one.

**Context.** `classifyUsageLimitError` reads the turn's error text. Decision 5 takes a fresh reading only after that text matches.

**Investigation.** `session-manager-prompt-handlers/result.ts` used to publish "Claude ended the turn on an API error." for any `subtype: "success"` with `is_error`, and [flake 0450](../../tests/flaky-tests/design-canvas-and-artifacts/0450-claude-live-design-account-rate-limit.md) shows that sentence on a real 429 whose real words were only in the rollout. The bridge now uses `result` when it names a usage limit. The pinned CLI 2.1.314 was given a scripted 429 with `anthropic-ratelimit-unified-status: rejected`: its `result` read "You've hit your weekly limit · resets …", which reached the turn's error and the classifier through the built bridge. So the wording is the CLI's own, but the HTTP that produced it is a fixture: without `anthropic-ratelimit-unified-representative-claim` the CLI retries instead, and which headers a real refusal sends is what this task is for. The same run shows `rate_limit_event.rate_limit_info.rateLimitType` naming the claim. A container's older bridge still sends the fixed sentence, and stays stopped.

**Decisions.**

- **How to get the evidence?**
  - **Use the next account that really runs out, on a `dev:test` profile with Debug logging (recommended).**
    - Pros: free apart from the turn it costs; real wording and timing.
    - Cons: depends on an account running out when someone is watching.
  - **Point a throwaway `CLAUDE_CONFIG_DIR` at a fake API that answers with the refusal.**
    - Pros: deterministic and repeatable. Now done by `verify:accounts:resend-live`.
    - Cons: proves the CLI's handling of the fake's headers, not that a real refusal sends them.

### 2. A real Codex weekly refusal

**Problem.** Which window is weekly on Codex is decided by its length, from the protocol and binary rather than from a real account.

**Context.** Pinned Codex 0.166.0. A real `usageLimitExceeded` turn fails with "You've hit your usage limit." in the bridge's own test fixture.

**Investigation.** `GetAccountRateLimitsResponse.ts` says `rateLimitsByLimitId` is keyed by metered `limit_id` "(for example, `codex`)". The binary's usage payload has `RateLimitStatusDetails` (`allowed`, `limit_reached`, `primary_window`, `secondary_window`) for `rate_limit`, and `AdditionalRateLimitDetails` (`limit_name`, `metered_feature`, `rate_limit`) for the rest. `plan-usage.test.ts` carries fixtures with the week in either slot, which is why the slot alone is not trusted.

**Decisions.**

- **What if a real account's week is neither slot at 10,080 minutes?**
  - **Leave it unconfirmed, which reads as no limit known (recommended until seen).**
    - Pros: never moves on a guess; a limit error just stays stopped.
    - Cons: the feature does nothing for that account.
  - **Also accept a window labelled weekly.**
    - Pros: covers an odd duration.
    - Cons: a metered feature's week could read the same.

### 3. A real model-specific refusal stays stopped

**Problem.** That these never move the machine is proven on fake readings only.

**Context.** Decision 4 of the original ticket. On Claude they are separate windows. The 5-hour limit used to be in this task; since 2026-11-05 it moves the machine (task 10).

**Investigation.** The check is the fresh reading: `seven_day` below 100% and `five_hour` below 98% means stay stopped. It is only as good as task 4. The stack's "another limit" case stays stopped on both CLIs, using a 5-hour refusal whose reading shows neither limit out, because no fixture has a real model refusal's headers. The `rateLimitType` in task 1 could say which limit without a read, if a real refusal carries it; that would also close task 4's window for Claude.

**Decisions.**

- **How to get the evidence?**
  - **Watch the next real Fable stop with the tick on (recommended).**
    - Pros: free apart from the turn it costs.
    - Cons: model limits are rarer than the general ones.
  - **Run a turn on purpose to exhaust a limit.**
    - Pros: on demand.
    - Cons: billed, and spends real allowance.

### 4. How soon a reading shows 100%

**Problem.** A refusal may come while the usage endpoint still says 99%, which reads as another limit, and the turn stays stopped with no resend.

**Context.** Between-turns switching still moves the machine at 98%, so the next prompt is fine. Only the resend of that one turn is lost, and only in that window.

**Investigation.** Unmeasured. A forced read goes to the provider, past the two-minute cache, except during a 429's wait.

**Decisions.**

- **If the lag is real, what then?**
  - **Keep it as built until measured (recommended).**
    - Pros: never resends on anything short of proof; simplest.
    - Cons: a stop in the window stays stopped.
  - **Treat 98% and up as used up after a limit error.**
    - Pros: covers rounding and short lag, and is what the 5-hour limit now does.
    - Cons: a Fable stop with weekly at 98.5% would resend, against decision 6.
  - **Read again a few times before deciding.**
    - Pros: keeps proof, and covers lag.
    - Cons: holds the workflow longer, and each read spends the endpoint's allowance.

### 5. The resend against a real provider

**Problem.** A real model has not been seen picking the work up from the continuation, in a conversation a real refusal ended.

**Context.** `mise run verify:accounts:resend-live` runs real bridges and the pinned CLIs against scripted provider servers. Run on 2026-11-01 on Claude 2.1.314 and Codex 0.166.0, it shows, for a native tab, a Multi Review's preparation, a build stage and a graph agent node: the refusing bridge process exits; a new one starts on the other login; that login's request holds the stopped prompt once, read from the shared transcript, then the continuation; no second resend follows; and neither login file changes.

**Investigation.** Mocks had passed all of this while real runs found three bugs: a planning turn resent as Build, a stopped turn holding back its own resend for two minutes, and the second of two tabs stopped together staying stopped. See [Bugs only the real stack showed](#bugs-only-the-real-stack-showed). What is left is what a fixture cannot say: whether a model given the marker carries on sensibly, and whether a refused turn's real rollout resumes as the fixture's did. A reviewer panel inside a real Multi Review is not reached, because it needs a preparation result and a validation run first; a graph of only that node runs the same `AgentBranchRunner`.

**Decisions.**

- **How much to run?**
  - **One native tab, the next time an account really runs out (recommended).**
    - Pros: the one thing still unproven is the model's behaviour, which does not vary by owner.
    - Cons: depends on an account running out when someone is watching.
  - **All four kinds of work.**
    - Pros: complete.
    - Cons: billed, needs an account near its limit four times, and repeats what the stack already shows.

### 6. Paid-overage fields on real accounts

**Problem.** Which fields say an account can bill is taken from the Agent SDK's types and the Codex binary, not from answers.

**Context.** `claudePaidOverage` and `codexPaidOverage` in `plan-usage.ts`. A missing field reads as "did not say", so an account is only avoided when the provider did say.

**Investigation.** The SDK types `extra_usage { is_enabled, monthly_limit, used_credits, utilization }` in its usage report, whose comment says it comes from the claude.ai usage endpoint, but the OAuth endpoint Orkestrator reads has not been seen answering it. The binary has `has_credits`, `unlimited`, `balance`, `allowed` and `limit_reached`.

**Decisions.**

- **How to check it?**
  - **Read the two endpoints once on each kind of account and compare the field names (recommended).**
    - Pros: a usage read costs no turn.
    - Cons: needs an account with paid usage on, and the answers must not be saved with their credentials.
  - **Leave it until a bill says otherwise.**
    - Pros: no work.
    - Cons: the guard could be silently doing nothing.

### 7. Two machines

**Problem.** The ticks, pins and notices across machines are tested with fakes on one machine.

**Context.** Sync is the existing `sync_controller_settings`. An older leaf's behaviour is the existing parser, tested with an unknown key.

**Investigation.** A leaf's switch reaches the command node's coordinators through its event stream, so a link that is down loses that notice while `lastSwitch` keeps it.

**Decisions.**

- **When?**
  - **With the two-machine batch in 0722 (recommended).**
    - Pros: one scheduling effort.
    - Cons: waits for that batch.
  - **On its own now.**
    - Pros: sooner.
    - Cons: two machines to set up twice.

### 8. The cost of a coordinator's notice

**Problem.** Decision 10 wants a notice on each automatic switch, and a notice wakes each main coordinator for a turn, which itself spends allowance.

**Context.** Switches should be rare, on the order of a week, but every project's main coordinator hears about each one.

**Investigation.** Unmeasured. The notice carries no action to take and says so.

**Decisions.**

- **Keep waking every main coordinator?**
  - **Yes, until a real week says otherwise (recommended).**
    - Pros: what was asked for, and simple.
    - Cons: many projects mean many short turns.
  - **Deliver it without a wake, read at the coordinator's next turn.**
    - Pros: costs no turn.
    - Cons: a coordinator planning around accounts learns late.

### 9. The flapping stops on rkmbp

**Problem.** rkmbp moved Claude Code five times in about 70 minutes on 2026-11-04 between two entries for one login, always for `soonest-reset`. The fix is proven only by replaying those readings through the rule and the switcher on fakes.

**Context.** The moves came at 01:29:49, 02:07:23, 02:27:23, 02:27:36 and 02:37:23. At 02:46:42 the two entries read 35% with resets at `2026-11-07T17:00:00.404Z` and `.464Z`, and a different login read 0% with a reset at `2026-11-09T21:00:00.485Z`. The same-login rule and the one-hour tolerance are in [When it moves](../../architecture/agent-accounts.md#when-it-moves).

**Investigation.** That the sub-second part of a reset changes between readings, so that the winner changes direction, is inferred from the moves running both ways. No two readings of one entry have been compared, and the build allowed no real usage calls. The replay swaps the values on purpose, and it fails on the old rule. The rule no longer depends on the answer: twins never move for `soonest-reset`, whatever their reset times do.

**Decisions.**

- **How to check it?**
  - **Watch rkmbp's `lastSwitch` and notices for a day after the fix reaches it (recommended).**
    - Pros: a read of what is already recorded; costs no turn and changes no setting.
    - Cons: needs the build deployed there, and quiet proves little if the machine is idle.
  - **Record two readings per entry over time on rkmbp to confirm the sub-second variation.**
    - Pros: settles the inference.
    - Cons: real usage calls for an answer the fix no longer needs.

### 10. A real 5-hour limit, there and back

**Problem.** Leaving on the 5-hour limit and returning when it resets is proven on fake readings and scripted servers only.

**Context.** How it behaves is in [When it moves](../../architecture/agent-accounts.md#when-it-moves). The Codex short window is identified by being shorter than a week, from `plan-usage.test.ts` fixtures rather than from an account at its limit.

**Investigation.** The stack's `native-five-hour` scenario shows the move and the continuation on the pinned CLIs. It says nothing about whether a real provider resets the window when it says, whether `resets_at` moves within a window, or whether usage can fall and so move the machine back early.

**Decisions.**

- **How to get the evidence?**
  - **Watch `lastSwitch` and the coordinator's notices through the next real 5-hour limit with the tick on (recommended).**
    - Pros: 5-hour limits are common, so this comes soon, and a read of what is already recorded costs no turn.
    - Cons: needs a second login with room at that moment.
  - **Run turns on purpose to fill a window.**
    - Pros: on demand.
    - Cons: billed, and spends real allowance.

## Assumptions and decisions

### Moving on the 5-hour limit (task 10)

- **What the 5-hour limit is allowed to change.**
  - **Who has room, never the order (chosen).**
    - Pros: this is what the ticket asks for: the soonest weekly account is always the goal, so the machine returns as soon as it can, and no reading of a fast-moving window can reorder accounts.
    - Cons: an account can be moved onto at 97% and left again soon after.
  - **Prefer accounts with more 5-hour room within the order.**
    - Pros: fewer moves.
    - Cons: burns later weeks while the soonest has room, which is the waste the ticket is against.
- **What confirms a 5-hour refusal.**
  - **At or past the 98% threshold (chosen).**
    - Pros: this window fills fast enough to read under 100% at the refusal, which would otherwise lose the resend. The machine leaves at 98% anyway, so the only cost is a model-limit refusal in that band being resent on another account, which is what the user wants then.
    - Cons: differs from the weekly limit, which stays at 100%.
  - **At 100%, as for the week.**
    - Pros: one rule.
    - Cons: task 4's unmeasured lag would strand the work in the case this ticket is about.
- **How the machine comes back.**
  - **A timer for the next reset, on top of a five-minute backstop (chosen).**
    - Pros: back as the window resets, at the cost of one check; needs no state beyond the process, because the next check re-arms it.
    - Cons: one more timer to clear on stop. Worth clamping, because `setTimeout` overflows on a nonsense reset far ahead and would fire at once in a loop.
  - **Only a shorter polling interval.**
    - Pros: no new moving part.
    - Cons: every check reads every included account, against an endpoint whose allowance a running session shares.
- **The backstop going from ten minutes to five.** A filling 5-hour window can pass from 98% to a refusal within ten minutes, so ten would often miss the threshold during a long turn with no turn-end edge. Reads remain cached for two minutes.
- **The move back keeps the one-hour reset tolerance.** Two weeks ending within the hour run out about together, so no allowance is at stake, and it is the same rule that stopped the flapping in task 9.
- **A reason of its own, `five-hour`.** The notice can then say which limit moved the machine. An older command node reads it as an unknown reason: it declines that notice, which goes to the leaf's own coordinator, one from before the notice hierarchy ignores the event, and `lastSwitch` is left out of its view of the leaf rather than failing it. Nothing new has to be kept for older peers.
- **"All providers" means Claude and Codex.** The ticket asks for every provider. Only these two hold more than one login, so the others have nothing to switch to, and nothing was added for them.

### Same-login entries and near-identical resets (task 9)

The rule moved in two places, each with its own decision.

- **Where the same-login rule lives.**
  - **In `rankAutoSwitchAccounts`' filter (chosen).**
    - Pros: `decideAutoSwitch` and the limit-stop path in `decideStop` both read that order, so neither can reach a twin; the sort is untouched.
    - Cons: the order no longer lists every entry with room.
  - **In `readings()`, marking twins used up by account id beside `confirmedOut`.**
    - Pros: small change in the backend.
    - Cons: covers only a confirmed stop, not `soonest-reset` or `threshold`, and leaves the pure rule unaware of logins.
- **How the tolerance is applied.**
  - **Only in `decideAutoSwitch`, against the top of the strict order (chosen).**
    - Pros: the order stays total and stable, and the soonest eligible login is the one that decides. The ticket requires it.
    - Cons: the limit-stop path, which reads the order directly, can still move a machine onto a login less than an hour sooner when its active login has room. The ticket's decision 3 leaves `limit` unheld, and it is one move rather than a flap.
  - **Bucketing resets inside the comparator.**
    - Pros: one place.
    - Cons: not transitive, so the order depends on input order.
- **A limit stop while the active entry is signed out.** A stop from another login can find the active entry signed out, and then the order may offer its twin. That move is still recorded as `limit`, because `decideStop` always reports that reason, but what it gains is a usable entry, which the ticket allows.
- **A stale reading of a twin.** It rules out an idle twin, as a stale reading past 98% with its reset ahead rules out the entry itself, and never moves the active entry, because only a fresh reading can say the active login has run out.
- **A fresh reading of a twin past 98% with no reading of the active entry.** The login is out and the machine moves with `threshold`, rather than staying as a missing reading otherwise would, because that reading is a fresh one of the same login.

### Whether a resend carries the prompt

- **Options.**
  - **A labelled continuation in the same session (chosen).**
    - Pros: cannot run the prompt twice; a turn that got partway continues; no prompt text has to be kept; matches the restart continuation and the capacity retry.
    - Cons: a turn refused before it began relies on the model picking the prompt up from the conversation; the marker shows as a user message in the tab.
  - **Send the original prompt again.**
    - Pros: certain to ask the same thing.
    - Cons: repeats finished work, and needs prompts and attachments kept, which the backend deliberately does not.
- **Chosen:** the continuation. Live check in task 5.

### Proving continuation without a billed turn

- **Options.**
  - **Real bridges and pinned CLIs against scripted provider servers (chosen).**
    - Pros: no billed turn or real login, repeatable, and the process replacement, transcript and resume are the real ones. It found three bugs mocks had passed.
    - Cons: says nothing about a real provider's refusal or a real model's reply; takes about seven minutes, so it is slow tier.
  - **Wait for a real account to run out.**
    - Pros: the whole truth.
    - Cons: billed, unrepeatable, and the bugs would have reached users first.
- **Chosen:** the first, with task 5 kept for what it cannot show.

### Bugs only the real stack showed

- **A planning turn came back as Build.** A prompt can state its mode without changing the session's controls, and the resend read the controls. On Claude that launched `--permission-mode=bypassPermissions` for work that had been planning only. It now reads `lastDispatchedTurn`.
- **A stopped turn held back its own resend for two minutes.** The bridge reports a failed turn by throwing, and `trackRunningTurns` only cleared a turn on a returned status. It looked like a sibling turn still running.
- **The second of two tabs stopped together stayed stopped.** Both sent at once, the first replaced the bridge, and the second failed on the closed connection. Resends now go one at a time per bridge.

### A resend's mode

- **Options.**
  - **Record each accepted turn's mode, and stay stopped without a record (chosen).**
    - Pros: a resend is what the turn was, whatever the controls say now; a missing record cannot widen authority.
    - Cons: one more field on the session; a parked dispatch later confirmed has no record, so that turn stays stopped.
  - **Fall back to plan with no record.**
    - Pros: never loses the resend.
    - Cons: would resend a Build turn in plan mode, which silently does nothing useful.
- **Chosen:** the first.

### A bridge shared by owners that cannot see each other

- **Options.**
  - **Leave it: a native tab's resend can replace a bridge a Multi Review's turn is on, and that turn continues through its restart path (chosen).**
    - Pros: as any switch behaves today, and the reviewer recovers.
    - Cons: the reviewer's running turn is cut short, and spends its one restart continuation.
  - **Make activity observation see workflow turns.**
    - Pros: nothing is cut short.
    - Cons: changes what every bridge replacement waits for, which is well outside this feature.
- **Chosen:** the first, until it shows up in use.

### Which turns qualify for a resend

- **Options.**
  - **Only an established `failed` outcome, seen as an edge while this backend runs, with the error naming a limit and a fresh reading confirming it (chosen).**
    - Pros: never resends a turn the user stopped, one a later prompt followed, or one with an unknown outcome; an old stop cannot resume when an account resets.
    - Cons: a stop during a backend restart stays stopped.
  - **Also look at each session's last turn on first observation, as incomplete-turn recovery does.**
    - Pros: survives a restart.
    - Cons: would resume work a person saw stop days ago, against decision 7, unless every stop's outcome were also recorded durably.
- **Chosen:** edges only. The durable dispatch journal still prevents a duplicate across a restart.

### Bounding a chain of refusals

- **Options.**
  - **Three resends per stopped turn, each needing another confirmed used-up account (chosen).**
    - Pros: a long task can use several accounts; ends even if readings misbehave.
    - Cons: a machine with more than four accounts stops early on one task.
  - **One resend.**
    - Pros: simplest.
    - Cons: a long stage that uses up its second account fails with a third unused.
- **Chosen:** three (`MAX_USAGE_LIMIT_RESENDS`). The id or record carries the count, so a restart cannot reset it.

### Whose stop it is when the session already reads the new account

- **Options.**
  - **Count it only if the turn was running before the last move, is not a resend, comes within five minutes, and a fresh reading of the account left shows its week used up (chosen).**
    - Pros: two turns stopped together both resend, even when the first's resend already replaced their bridge; a Fable or 5-hour refusal on the new account stays stopped, as the ticket asks.
    - Cons: a turn refused so quickly no sweep saw it running can read as sent after the move, and stays stopped.
  - **Treat any stop within five minutes of a move as the old account's.**
    - Pros: simplest; never loses a sibling's resend.
    - Cons: resends a model-specific refusal on the new account up to three times, including a prompt the user just typed. This was the first build, and a review found it.
- **Chosen:** the first.

### A workflow's next turn after a between-turns move

Workflow providers now refresh the connection before creating a session and
preparing a turn. This applies to build pipelines, Multi Review and graph runs.
The cached provider keeps its identity while the connection receives the new
bridge token. A shared registry of provider observations and sends preserves
another workflow owner's running turn. Native activity protection remains in
the local bridge startup path. The deterministic test is
`workflow-account-handoff.test.ts`; task 5 remains open for live qualification.

### Stale and unknown readings

- **Options.**
  - **Only a fresh reading can say "used up" about the active account; a stale reading past 98% with its reset ahead keeps an idle account out; no reset to go on ranks last (chosen).**
    - Pros: a stale reading never causes a false "used up", and a past reset never counts as known; a weekly limit does not fall before its reset, so that one exclusion is sound.
    - Cons: an idle account whose provider moved its reset early stays out until the old reset.
  - **Ignore every stale reading.**
    - Pros: simplest.
    - Cons: idle Claude accounts are usually stale, so the order would mostly be guesswork, and a used-up account would get switched onto and refuse.
- **Chosen:** the first. See [Stale and unknown readings](../../architecture/agent-accounts.md#stale-and-unknown-readings).

### Moving when the active account still has room

- **Options.**
  - **Move whenever another included account resets sooner (chosen, then narrowed to more than an hour sooner by another login; see task 9).**
    - Pros: this is what stops allowance expiring unused, and acceptance asks that the machine move to the account that resets soonest.
    - Cons: moves more often than only at 98%, and the first tick can switch at once.
  - **Move only at 98% or a limit.**
    - Pros: fewest switches.
    - Cons: an account with days of unused allowance sits idle until the active one runs out.
- **Chosen:** the first. A tie stays put. The original build reasoned that reset times do not change within a window, so it could not flap; rkmbp showed otherwise, on two entries for one login (task 9).

### Paid overage

- **Options.**
  - **Read what providers report and never choose an account that says it would bill; say plainly what it cannot see (chosen).**
    - Pros: follows the coordinator's recommendation where it can be detected.
    - Cons: an account with no reading at all can still be chosen as a last resort, and the fields are unconfirmed (task 6).
  - **Refuse any account without a fresh reading.**
    - Pros: can never move onto overage blind.
    - Cons: idle Claude accounts rarely have one, so the feature would mostly do nothing.
- **Chosen:** the first. See [Paid overage](../../architecture/agent-accounts.md#paid-overage).

### Accounts with no email

- **Options.**
  - **Unticked until ticked on that machine, kept there, never travelling (chosen).**
    - Pros: they cannot be matched elsewhere, and such a login is often a pay-per-use API key.
    - Cons: a real subscription with no email needs a tick on each machine.
  - **Included like the rest.**
    - Pros: fewer ticks.
    - Cons: could move a machine onto metered billing by default.
- **Chosen:** the first.

### Older machines

- **Options.**
  - **Rely on the inherited-settings rules that exist (chosen).**
    - Pros: an older leaf drops the key and keeps working, and an older command node sends none, so a newer leaf reads off. Nothing new can break, and `set_active_agent_account` gained no argument.
    - Cons: an older leaf does not switch, and only shows that by having no ticks.
  - **Version-gate the sync and report it per machine.**
    - Pros: can say why.
    - Cons: machinery for a mixed state that upgrades away.
- **Chosen:** the first.

### Where the ticks are stored

- **Options.**
  - **In the global config, written only by a dedicated command (chosen).**
    - Pros: travels and layers like every other inherited setting; a whole-config save cannot undo a coordinator's change.
    - Cons: one more exception in `updateGlobalConfig`.
  - **In `agent-accounts.json` beside the pin.**
    - Pros: no renderer race at all.
    - Cons: would need its own sync path, against the ticket's use of the existing one.
- **Chosen:** the first. Pins are per machine, so they are in `agent-accounts.json`.
