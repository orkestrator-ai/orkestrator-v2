# Design canvas

The design canvas and its agent tools: qualification evidence, operation recovery edges, design-to-agent conversation links and accessibility findings.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md) | Medium | backlog | Task 4 needs a human screen-reader user (VoiceOver, NVDA on Windows); task 5 a slower machine; task 12 the Apple M5 Max run; task 3's menu-key pass an unshared macOS desktop session. | Live-agent, container, Electron, accessibility, client-performance and mixed-version evidence (container, Electron, automated accessibility and performance recorded 2026-10-22; the opening prompt, Orkestrator-container export, mixed versions with the published 2.22.3 backend and flake 0174 done 2026-10-25; container export on Linux Docker Engine, Linux client performance and flakes 0208 and 0174 done 2026-11-01); optimisations deferred until measured. On 2026-11-06 the 64-frame retention run converged on Linux (task 12), the Linux performance rerun was recorded (task 5) and the renderer's v1 design fallback was retired (task 6); the M5 Max retention run is left. | What is left is platform and human qualification: a screen-reader pass, a slower machine and the Electron renderer for performance, the M5 Max retention run, the packaged and native Electron paths, and an old renderer binary. |
| 2 | [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md) | Low | backlog | — | Design-to-agent links that survive tab closure and Resume (done 2026-10-24); two live clients resuming at once and a close after the bridge lost the session done 2026-10-25; left: an archived state once native archive exists. | Everything shipped and was qualified live with Claude and Codex; the only remaining work is blocked on 0006. |
| 3 | [7440-design-perf-listener-count-two-states.md](7440-design-perf-listener-count-two-states.md) | Low | backlog | — | The client perf harness's 12-cycle leak check fails on a `jsEventListeners` count that alternates between two fixed values without growing (found 2026-11-06): name the listeners, then fix the check. | Evidence quality only: every other leak signal converged, and the 100-cycle run shows no growth. |
