# Launch-override marker review repair: component browser owners

- **ID:** 9953
- **Status:** open
- **Date observed:** 2026-11-11
- **Branch / base:** `launch-override-marker-043a84998c41-r1` at `a600bdd5a`, merge base `498b68766f5c9f357a3a86782406d1e9e0977559`.
- **Original command:** `mise run test:logged -- --name browser-rerun -- mise run test:browser`, Playwright config defaults, both Chromium viewport projects, host load average about 42.
- **Aggregate result:** killed at the runner's 1,800 s group deadline at progress 1,129/1,846: the mobile project had finished and the desktop project had reached `e2e/DiffBase.spec.ts`. Nine named failures; public-site tests not reached.
- **Evidence:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.eQd4Qq/browser-rerun.log.gz`.

## The one failure this branch caused

`e2e/TabLaunchOverride.spec.ts` ("the whole strip makes one coordinator read"
and the branch's new leaf case) failed 4 of 8 when run alone: two command-node
reads instead of one. The fixture renders under React StrictMode, whose effect
replay re-retained the override store while its first read was running; that
queued a second read after the 500 ms coalescing window, so the count depended
on whether the spec's click landed before it. This is the `TabLaunchOverride`
failure case [7272](7272-transcript-repair-browser-owners.md) left unclassified.
Commit `a600bdd5a` lets a remount join an in-flight read started within the
window (unit tests in `coordinatorLaunchOverrideStore.test.ts`); afterwards the
spec passed 24 of 24 with `--repeat-each=3` at load average about 33. It is a
product fix, not a flake.

## Failures whose complete owning file passed alone

| Project | Owning file and exact test | Aggregate failure | Owner result |
| --- | --- | --- | --- |
| mobile | `e2e/InteractionPolicyChecks.spec.ts:198` a coordinator turn delegates through Orkestrator tools, is refused a write and asks a question | route callback after the page closed | Passed (four-owner rerun, default workers) |
| mobile | `e2e/PaneBreakpoint.spec.ts:103` split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore) | anchor "Transcript message 35." instead of 36 | Passed; the pane-tree variant then failed (0342) and passed with one worker |
| mobile | `e2e/SidebarMotion.spec.ts:26` real panels restore width, bound reversal pins and release once | three sizes, bound two | Passed (four-owner rerun) |
| mobile | `e2e/SidebarMotion.spec.ts:167` root CSS zoom 0.8 keeps pins in layout pixels | `NaN` against `<= 487.5` | Passed (four-owner rerun) |
| mobile | `e2e/DataSavingGateway.spec.ts:18` data saving survives reload… (1310) | 60 s deadline | Failed in the four-owner rerun; passed with one worker |
| desktop | `e2e/ChangeTracking.spec.ts:137` an unreachable image stream retries base64 and releases its capability | 30 s deadline, image attribute | Passed with one worker |
| desktop | `e2e/ChangeTracking.spec.ts:80` real change commands retain history and tool evidence… | 30 s deadline | Passed with one worker |
| desktop | `e2e/CodexSubagentCards.spec.ts:185` Codex sub-agent cards stay one per child through reload and a cold restart | card count 0, expected 1 | Passed with one worker |
| desktop | `e2e/DesignCanvas.spec.ts:50` canvas edits, script isolation, missed events, conflict and reload | 42 s deadline, count mismatch | Passed with one worker |

The desktop specs the killed run never reached then ran on their own
(`--project=desktop-chromium` with every spec from `DiffBase` on, default
workers): 686 passed, 30 skipped, two failed, in 19.1 min. Both failures,
`DataSavingGateway.spec.ts:18` (1310) and `TranscriptPaging.spec.ts:42`
"native: paging before prose holds the original tool position" (0483), passed
with one worker (129.4 s). `TabLaunchOverride.spec.ts` passed there on
desktop. The public-site suite passed (13.8 s).

Commands (one per owner group, each through `test:logged`):

```sh
bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --project=mobile-chromium e2e/InteractionPolicyChecks.spec.ts e2e/PaneBreakpoint.spec.ts e2e/SidebarMotion.spec.ts e2e/DataSavingGateway.spec.ts
bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --project=mobile-chromium e2e/PaneBreakpoint.spec.ts e2e/DataSavingGateway.spec.ts --workers=1
bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --project=desktop-chromium e2e/ChangeTracking.spec.ts e2e/CodexSubagentCards.spec.ts e2e/DesignCanvas.spec.ts --workers=1
bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --project=desktop-chromium e2e/DataSavingGateway.spec.ts e2e/TranscriptPaging.spec.ts --workers=1
```

None of these owners imports the changed store, and none was changed. No
assertion, deadline, retry or skip changed. This establishes intermittency
under host load, not its cause; known cases record their own recurrences
(0342, 1310, 0483).
