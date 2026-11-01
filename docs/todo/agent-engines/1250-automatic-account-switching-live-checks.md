# Automatic account switching: live checks

## Task analysis

Analysed 2026-11-01 against the branch built from `main` at `93b99bfba`. How it
works is in [agent-accounts.md](../../architecture/agent-accounts.md#automatic-switching).

The feature is built and tested on fake accounts and readings. Nothing here has
met a real account running out: that needs an exhausted subscription, and the build
that added it was not allowed billed turns or real logins. Each task needs a real
provider, so none can run in CI.

### Tasks

1. **A real Claude weekly refusal**: the refusal's words reach the turn's error, a forced read shows `seven_day` at 100%, and the machine moves. Status: open; needs a Claude account at its weekly limit.
2. **A real Codex weekly refusal**: the same for Codex, and which slot holds the week on a real account. Status: open; needs a Codex account at its weekly limit.
3. **A real model-specific or 5-hour refusal stays stopped**: a Fable or 5-hour refusal moves nothing and resends nothing. Status: open; needs an account at one of those limits with weekly room.
4. **How soon a reading shows 100%**: whether the usage endpoint can still say under 100% just after the refusal. Status: open; decides whether a confirmed stop needs a second look.
5. **The resend on a real replaced bridge**: the conversation continues from the shared transcript on the new account, in a native tab, a Multi Review, a build pipeline and a graph run. Status: open; billed.
6. **Paid-overage fields on real accounts**: Claude's `extra_usage` on the OAuth usage endpoint; Codex's `credits` and `rate_limit.limit_reached` on the HTTP one. Status: open.
7. **Two machines**: the ticks reach a leaf by email, a pin on the leaf, a notice from a leaf's switch reaching the command node's coordinator, and an older leaf. Status: open; joins the two-machine batch in [0722](0722-per-machine-agent-accounts.md).
8. **The cost of a coordinator's notice**: each notice wakes a main coordinator for a turn. Status: open; decide after watching a real week.

### 1. A real Claude weekly refusal

**Problem.** The whole path after a Claude limit rests on what its result message holds at that moment, and no fixture was recorded from a real one.

**Context.** `classifyUsageLimitError` reads the turn's error text. Decision 5 takes a fresh reading only after that text matches.

**Investigation.** `session-manager-prompt-handlers/result.ts` used to publish "Claude ended the turn on an API error." for any `subtype: "success"` with `is_error`, and [flake 0450](../../tests/flaky-tests/design-canvas-and-artifacts/0450-claude-live-design-account-rate-limit.md) shows that sentence on a real 429 whose real words were only in the rollout. The bridge now uses `result` when it names a usage limit. That `result` holds the refusal's words is taken from the SDK's documented result shape and the existing test wording ("You've hit your limit · resets 3pm"), not from a recording. A container's older bridge still sends the fixed sentence, and stays stopped.

**Decisions.**

- **How to get the evidence?**
  - **Use the next account that really runs out, on a `dev:test` profile with Debug logging (recommended).**
    - Pros: free apart from the turn it costs; real wording and timing.
    - Cons: depends on an account running out when someone is watching.
  - **Point a throwaway `CLAUDE_CONFIG_DIR` at a fake API that answers with the refusal.**
    - Pros: deterministic and repeatable.
    - Cons: only proves the fake's wording, which is the thing in question.

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

### 3. A real model-specific or 5-hour refusal stays stopped

**Problem.** That these never move the machine is proven on fake readings only.

**Context.** Decision 4 of the ticket. On Claude they are separate windows; on Codex the 5-hour limit is the other slot.

**Investigation.** The check is the fresh reading: `seven_day` below 100% means stay stopped. It is only as good as task 4.

**Decisions.**

- **How to get the evidence?**
  - **Watch the next real 5-hour stop with the tick on (recommended).**
    - Pros: 5-hour stops are common, so this comes soon and for free.
    - Cons: Fable and other model limits are rarer.
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
    - Pros: covers rounding and short lag.
    - Cons: a 5-hour stop with weekly at 98.5% would resend, against decision 6.
  - **Read again a few times before deciding.**
    - Pros: keeps proof, and covers lag.
    - Cons: holds the workflow longer, and each read spends the endpoint's allowance.

### 5. The resend on a real replaced bridge

**Problem.** The replaced bridge resuming the conversation is documented behaviour for a switch, but has not been seen with a turn that ended on a refusal, or with a workflow's new request.

**Context.** Tests assert the prompt, session and request id at the provider boundary. The bridge replacement itself is `localBridgeIsOnActiveAccount`, unchanged.

**Investigation.** Claude keeps a warm CLI per session, so a bridge that is not replaced would answer on the old login: the resend waits for the bridge to go idle and each workflow drops its cached provider. A workflow's cached provider otherwise stays on its old bridge after any switch, until it stops answering, so the next stage after a between-turns switch can hit the limit once on the old account and then move through this same path.

**Decisions.**

- **How much to run?**
  - **One native tab and one Multi Review, then watch the rest in use (recommended).**
    - Pros: cheapest proof of both resend paths.
    - Cons: build pipelines and graph runs rest on the shared path being the same.
  - **All four kinds of work.**
    - Pros: complete.
    - Cons: billed, and needs an account near its limit four times.

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

## Assumptions and decisions

### Whether a resend carries the prompt

- **Options.**
  - **A labelled continuation in the same session (chosen).**
    - Pros: cannot run the prompt twice; a turn that got partway continues; no prompt text has to be kept; matches the restart continuation and the capacity retry.
    - Cons: a turn refused before it began relies on the model picking the prompt up from the conversation; the marker shows as a user message in the tab.
  - **Send the original prompt again.**
    - Pros: certain to ask the same thing.
    - Cons: repeats finished work, and needs prompts and attachments kept, which the backend deliberately does not.
- **Chosen:** the continuation. Live check in task 5.

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
  - **Move whenever another included account resets sooner (chosen).**
    - Pros: this is what stops allowance expiring unused, and acceptance asks that the machine move to the account that resets soonest.
    - Cons: moves more often than only at 98%, and the first tick can switch at once.
  - **Move only at 98% or a limit.**
    - Pros: fewest switches.
    - Cons: an account with days of unused allowance sits idle until the active one runs out.
- **Chosen:** the first. A tie stays put, and reset times do not change within a window, so it cannot flap.

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
