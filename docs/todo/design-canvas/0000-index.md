# Design canvas

The design canvas and its agent tools: qualification evidence, operation recovery edges and accessibility findings.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md) | Medium | backlog | — | Live-agent, container, Electron, accessibility, client-performance and mixed-version evidence (container, Electron, automated accessibility and performance recorded 2026-10-22; the opening prompt, Orkestrator-container export, mixed versions with the published 2.22.3 backend and flake 0174 done 2026-10-25; container export on Linux Docker Engine, Linux client performance and flakes 0208 and 0174 done 2026-11-01); optimisations deferred until measured. On 2026-11-06 the 64-frame retention run converged on Linux (task 12), the Linux performance rerun was recorded (task 5) and the renderer's v1 design fallback was retired (task 6). The screen-reader pass, the macOS menu-key pass, the slower-machine run and the M5 Max retention run moved to 7568 on 2026-11-10. | What is left here is agent-runnable platform qualification and decisions: the macOS packaged bundle, a published old renderer against this backend and the reverse, the Save dialog, Ctrl/⌘+0 and Electron-performance decisions, and the deferred optimisations and open questions. |
| 2 | [7820-design-perf-cdp-frames-transient.md](7820-design-perf-cdp-frames-transient.md) | Low | backlog | — | The client perf harness's 12-cycle leak check failed once on `cdpFrames` reading 10 instead of 9 on two late samples, ending at 9, on a heavily loaded host (found 2026-11-11 while verifying 7440's fix): name the frame, then decide whether the check should tolerate it. | Evidence quality only: one run of nine, every other leak signal converged, and the 2140 growth stays fixed. |
