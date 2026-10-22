# Design canvas

The design canvas and its agent tools: qualification evidence, operation recovery edges and design-to-agent conversation links.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md) | Medium | No | Live-agent, container export, Electron, accessibility and performance evidence; optimisations deferred until those numbers exist. | Container export, Electron, accessibility and performance evidence is missing for a shipped surface. |
| 2 | [0037-design-operation-recovery-edges.md](0037-design-operation-recovery-edges.md) | Medium | No | Operation-receipt and restart-recovery gaps in the design tools and renderer. | A hung renderer `browser.close()` may leak Chromium; the rest is narrow receipt and recovery edges. |
| 3 | [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md) | Medium | No | Design-to-agent handoff links that survive tab closure, and design context sent as structured input. | Design links break when the agent tab closes; a product gap with a workaround. |
