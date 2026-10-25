# Service previews and web annotations

Service previews (desktop tunnel, private origins, relay, embedded and discovered services) and web-page annotations (qualification, known limitations, extensions).

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0042-service-preview-rollout.md](0042-service-preview-rollout.md) | High | No | Qualify the shipped preview transports (desktop tunnel, private origins, relay) on real platforms, set thresholds, flip defaults, then retire the legacy loopback route and stale partitions. Holds the preview evidence log. | The two-machine tailnet qualification gates flipping the preview defaults, and it holds the most open work in the folder. |
| 2 | [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md) | Medium | No | Real-stack evidence for web-page annotations: native window, live providers, Docker and remote workspaces, web/iOS review, baselines and sign-off. | On by default; milestones A–C now have sign-off records (awaiting human review), Docker, needs-input, disruption, comparison and web review pass. Left: a remote backend on another host, the iOS wrapper, and native focus/keyboard resolve on a frontmost host. |
| 3 | [0045-preview-service-discovery.md](0045-preview-service-discovery.md) | Medium | No | Local-worktree service seeding, managed-process ownership, agent links to preview tabs, framework setup hints. | Local-worktree service seeding is a functional gap; the rest is optional. |
| 4 | [0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md) | Medium | No | Cross-service read policy on private origins (Fetch Metadata refusal of non-navigation requests from siblings), done and Chromium-verified; Firefox, Safari and a live Tailscale Serve check remain. | The fix is in; what is left is a secondary-browser and forwarder qualification of an opt-in feature. |
| 5 | [0046-embedded-service-previews.md](0046-embedded-service-previews.md) | Low | No | Embedded previews in the web client (iframe) and iOS (dedicated `WKWebView`). Not started; top-level handoff is the only path today. | Not started, and top-level handoff works today. |
| 6 | [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) | Low | No | Deferred annotation capabilities: pixel diffs, automatic after-capture, source hints, shadow/iframe targets, non-desktop capture. | Deferred, optional capabilities. |
| 7 | [0124-web-annotation-commit-cost.md](0124-web-annotation-commit-cost.md) | Low | No | Every annotation commit deep-copies the manifest and re-diffs every index row, so CPU per write grows with the collection (about 20 ms at the 2,000-note cap on a loaded host). | An optimisation with bounded I/O that matters only near the cap. |
| 8 | [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md) | Low | Yes | Code gaps in shipped annotations, all closed: backend-assigned region crop relation, pin generation checks, container file checks, client-declared producer labels, read-only Discuss in sessions already in Plan, turn-end outcome reads, exact tray capacity, diagnostics series. | Nothing remains; kept for review of its decisions and live evidence, then delete (behaviour is in `web-page-annotations.md`). |
