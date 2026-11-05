# Agent card state authority timing

- **ID:** 4842
- **Status:** resolved
- **Observed:** 2026-11-05
- **Test:** `AgentNativeTab progressive controller > keeps Claude agent-card position through unavailable-state until authority returns`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx`

Preparation's `mise run test` at cd5b0142 reported this assertion after 1058.59 ms: the Stop Investigate rendering button was still present when absence was expected (line 676). The recorded aggregate had ten named failures and errors outside tests; the package does not provide a reliable combined test total. Worker allocation was controlled by the aggregate runner, not supplied explicitly on its command line.

The owning file passed alone on the repair branch with:

```sh
mise run test:logged -- --name recorded-agent-card -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures
```

The complete file passed in 8.5 seconds (114 output bytes; passing log removed by the logged runner). No assertion was weakened or skipped. The original failure remains in `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt` around lines 1509–1522. The test waits for transcript text before checking state authority, while those reads run independently; ordering under aggregate load needs further investigation. This is a hypothesis, not an established cause.

## Resolution (2026-11-05)

**Root cause.** The test's backend mock answered every state read that no
scripted update covered with `unchanged`. After the scripted `unavailable` (or
rejected) read, the hook drops its state token and Stop disappears, but the
next background poll that landed before the test scripted the held recovery
read got that `unchanged` reply. The hook treats `unchanged` as current
authority (`useNativeAgentSession.ts`, progressive state read), so Stop came
back before line 676 asserted its absence. A real bridge cannot answer
`unchanged` to a read that carries no known token, so the reply was a
fixture artefact, and how often a poll fell in that window depended on load.
The `failed-read` case had the same window.

**Fix.** The test file gains a `stateFallback` hook for unscripted state reads.
The two outage transitions set it to keep reporting the outage (the rejection
or the `unavailable` reply) until the held recovery read is scripted, and clear
it at that point; every other test keeps the `unchanged` default. No assertion
was weakened or skipped, and no product code changed.

**Verification.** A temporary three-second `act` wait inserted before the
recovery is scripted (standing in for aggregate-load lag) made the old test
fail in both `failed-read` and `unavailable-state`, and the fixed test pass all
three cases. Without the wait, the whole file passed through
`mise run test:logged -- --name agent-native-progressive -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures`
(with `NODE_ENV=test`, 11.6 s), and the three parameterised cases passed five
repeated runs.
