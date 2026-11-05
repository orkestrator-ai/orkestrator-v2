# Agent card state authority timing

- **ID:** 4842
- **Status:** open
- **Observed:** 2026-11-05
- **Test:** `AgentNativeTab progressive controller > keeps Claude agent-card position through unavailable-state until authority returns`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx`

Preparation's `mise run test` at cd5b0142 reported this assertion after 1058.59 ms: the Stop Investigate rendering button was still present when absence was expected (line 676). The recorded aggregate had ten named failures and errors outside tests; the package does not provide a reliable combined test total. Worker allocation was controlled by the aggregate runner, not supplied explicitly on its command line.

The owning file passed alone on the repair branch with:

```sh
mise run test:logged -- --name recorded-agent-card -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures
```

The complete file passed in 8.5 seconds (114 output bytes; passing log removed by the logged runner). No assertion was weakened or skipped. The original failure remains in `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt` around lines 1509–1522. The test waits for transcript text before checking state authority, while those reads run independently; ordering under aggregate load needs further investigation. This is a hypothesis, not an established cause.
