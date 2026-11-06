# Live checks for a conversation whose platform is unavailable

## Task analysis

Analysed 2026-11-05 against main at 41f9eb638, with to-do 4881 (reading a conversation whose platform is unavailable) applied.

### Tasks

1. **Turning the platform back on, against a real provider history**: needs a real provider session. Status: open.
2. **A turn already running when its platform goes off**: running state and Stop implemented with fake-provider coverage; live qualification remains. Status: open.

### 1. Turning the platform back on, against a real provider history

**Problem.** Nothing has shown a real provider's history coming back after the platform is turned on again.

**Context.** From to-do 4881, which forbade billed provider turns. Its isolated profile ran with no credentials and a seeded transcript.

**Investigation.** On an isolated, credential-free `dev:test` profile on 2026-11-05, turning Codex back on cleared the banner and restored the normal composer, and the pane sent `ensure_native_agent_session`. The seeded thread was not a real one, so the pane then showed an empty conversation and not the saved transcript. No prompt was sent. `native-agent-service-held-coordinator.test.ts` and `CoordinatorPanel.outcome.test.tsx` cover the resume with a scripted provider. Not covered: a real rollout read after the hold ends.

**Decisions.**

- **How to check it?**
  - **On a dev profile with credentials, run one turn, turn the platform off and on, and read the transcript (recommended).**
    - Pros: covers the real resume and a real history read.
    - Cons: costs one provider turn.
  - **Add it to the [4880](4880-c6-live-checks.md) run.**
    - Pros: shares that run's provider turn.
    - Cons: ties this check to a run that needs an older build as well.

### 2. A turn already running when its platform goes off

**Problem.** Saving the setting does not stop a running turn, and the held pane then shows it as over.

**Context.** From to-do 4881. The original held state always answered `idle`; the review repair now reads activity from an already cached provider and permits Stop against it. Pausing uses the same repair.

**Investigation.** Read in code on 2026-11-05, not seen live. No backend path that reads `coordinatorProviderTiers` or `enabledAgentPlatforms` stops a turn when they change. The activity sweep still observes the conversation, because `coordinatorConversationRunnable` does not consider the platform, so the project's icon can show work while the pane reads as idle. The transcript is the saved tail, so it stops growing until the platform is back. Before 4881 the pane read nothing at all in this state, so the gap is not new, but it is now visible.

**Decisions.**

- **What should happen to the turn?**
  - **Leave it running and have the pane say so, keeping Stop available (recommended).**
    - Pros: changing a setting does not throw away work, and the user can still end it.
    - Cons: the held read has to report activity it does not report today, and Stop must not start a provider.
  - **Stop the turn when the setting is saved.**
    - Pros: "off" then means nothing is running.
    - Cons: a settings save would cancel work in every conversation on that platform, with no warning.
  - **Leave it as it is.**
    - Pros: no work.
    - Cons: the pane can read as idle while a turn runs.

## Assumptions and decisions

### Task 2: preserve existing work and expose Stop

The review repair leaves existing turns running when settings change, and reads
activity from the provider already cached in the backend. Stop uses that same
provider and never resolves a new one while held. This preserves work and
supports inactive panes and renderer reloads. When no provider is cached, reads
keep saved idle state; this does not qualify backend-restart recovery of an
already running bridge. Fake-provider tests cover both platform holds, repeated
reads, refused new prompts, and Stop. A real running turn still needs live
qualification under the original no-billed-turn constraint.

### Task 1: prove continuity with recognizable fake history

Both release tests now read the held transcript, release the platform hold,
ensure the session, then read the live transcript and assert the original
provider session id and recognizable history. This closes the fake-provider
coverage gap; it does not replace the real-provider rollout check above.
