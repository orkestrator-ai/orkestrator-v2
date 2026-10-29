# Design canvas

The design canvas and its agent tools: qualification evidence, operation recovery edges, design-to-agent conversation links and accessibility findings.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md) | Medium | No | Live-agent, container, Electron, accessibility, client-performance and mixed-version evidence (container, Electron, automated accessibility and performance recorded 2026-10-22; the opening prompt, Orkestrator-container export, mixed versions with the published 2.22.3 backend and flake 0174 done 2026-10-25); design flakes; optimisations deferred until measured. | What is left is platform and human qualification: Docker Engine on Linux, a screen-reader pass, other hosts and the Electron renderer for performance, the packaged and native Electron paths, an old renderer, and flake 0208. The opening prompt users hit is now backend-owned. |
| 2 | [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md) | Low | No | Design-to-agent links that survive tab closure and Resume (done 2026-10-24); two live clients resuming at once and a close after the bridge lost the session done 2026-10-25; left: an archived state once native archive exists. | Everything shipped and was qualified live with Claude and Codex; the only remaining work is blocked on 0006. |
