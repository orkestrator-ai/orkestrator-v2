# Design canvas

The design canvas and its agent tools: qualification evidence, operation recovery edges, design-to-agent conversation links and accessibility findings.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md) | Medium | No | Live-agent, container, Electron, accessibility and client-performance evidence (container, Electron, automated accessibility and performance recorded 2026-10-22); the new-tab opening prompt; mixed versions; design flakes; optimisations deferred until measured. | A new design tab's opening prompt waits for the tab to mount; the screen-reader pass, an Orkestrator-created container and real old binaries are still unqualified. |
| 2 | [0054-design-canvas-accessibility-findings.md](0054-design-canvas-accessibility-findings.md) | Medium | No | Accessibility defects the automated pass found but did not fix: the 400% zoom layout, label-in-name on inspector fields, and a silent first Enter on an unrendered frame's row. | Low-vision keyboard users cannot see the panels at 400% zoom; a functional gap with a workaround (lower zoom). |
| 3 | [0037-design-operation-recovery-edges.md](0037-design-operation-recovery-edges.md) | Low | No | Operation-receipt and restart-recovery gaps in the design tools and renderer. Legacy-canvas interruptions, interrupted duplicates and the hung renderer close were fixed on 2026-10-23. | Only the pre-digest receipt fallback is left, deferred until the support window (0034) no longer covers backends older than 2.21.0. |
| 4 | [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md) | Low | No | Design-to-agent links that survive tab closure and Resume (done 2026-10-24); left: a two-live-client Resume run, a Codex close replayed after a bridge restart, and an archived state once native archive exists. | The links, Resume, link states and annotation chips shipped and were qualified live with Claude and Codex; what remains is an edge already covered by deterministic tests, a rare replay edge, and work blocked on 0006. |
