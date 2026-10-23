# Service previews and web annotations

Service previews (desktop tunnel, private origins, relay, embedded and discovered services) and web-page annotations (qualification, known limitations, extensions).

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0042-service-preview-rollout.md](0042-service-preview-rollout.md) | High | No | Qualify the shipped preview transports (desktop tunnel, private origins, relay) on real platforms, set thresholds, flip defaults, then retire the legacy loopback route and stale partitions. Holds the preview evidence log. | The two-machine tailnet qualification gates flipping the preview defaults, and it holds the most open work in the folder. |
| 2 | [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md) | Medium | No | Code gaps in shipped annotations: region crop provenance, pin generation checks, container file checks, producer attestation, Discuss enforcement, missing metrics. | Code gaps in shipped annotations, including container path containment checks and unverified capture producers. |
| 3 | [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md) | Medium | No | Real-stack evidence for web-page annotations: native window, live providers, Docker and remote workspaces, web/iOS review, baselines and sign-off. | Annotations are on by default and the main gates are signed off; Docker, remote, Discuss and latency evidence remain. |
| 4 | [0045-preview-service-discovery.md](0045-preview-service-discovery.md) | Medium | No | Local-worktree service seeding, managed-process ownership, agent links to preview tabs, framework setup hints. | Local-worktree service seeding is a functional gap; the rest is optional. |
| 5 | [0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md) | Medium | No | Cross-service read policy on private origins (Fetch Metadata refusal of non-navigation requests from siblings), done and Chromium-verified; Firefox, Safari and a live Tailscale Serve check remain. | The fix is in; what is left is a secondary-browser and forwarder qualification of an opt-in feature. |
| 6 | [0046-embedded-service-previews.md](0046-embedded-service-previews.md) | Low | No | Embedded previews in the web client (iframe) and iOS (dedicated `WKWebView`). Not started; top-level handoff is the only path today. | Not started, and top-level handoff works today. |
| 7 | [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) | Low | No | Deferred annotation capabilities: pixel diffs, automatic after-capture, source hints, shadow/iframe targets, non-desktop capture. | Deferred, optional capabilities. |
