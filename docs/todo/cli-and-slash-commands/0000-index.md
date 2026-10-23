# CLI and slash commands

The public `orkestrator` CLI and the slash-command catalogue: missing features, catalogue cleanup and live qualification.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0014-cli-qualification.md](0014-cli-qualification.md) | Medium | No | Live Pi, Cursor and Grok qualification runs (the scenario can now drive them), per-run model records, macOS packaging and profile checks, other-provider browser cards and the foreign-owner Docker decoy. Holds the CLI evidence log. | Pi, Cursor and Grok are still unqualified for request-specific completion, so scripts on them cannot use `run wait` as a success signal. |
| 2 | [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) | Medium | No | Retire the legacy command-catalogue routes; decide the deliberately unavailable command classes (Claude session-changing commands, Codex inline-shell templates, Pi UI extensions). | The legacy catalogue routes and the old-bridge fallback that shows guessed rows still need retiring. |
| 3 | [0017-cli-command-surface.md](0017-cli-command-surface.md) | Medium | No | CLI features left out of the first release: selected slash commands, enqueue, attachments, cascade remove, local init, event following, worker credentials. | CLI features left out of the first release (slash commands, enqueue, attachments, worker credentials); functional gaps, not defects. |
| 4 | [0015-slash-command-qualification.md](0015-slash-command-qualification.md) | Low | No | Live slash-command qualification record (all six providers, host and container browser runs, Pi, Codex disabled skills, mixed-version fakes, catalogue performance); left: a run against real pre-#827 builds. | The only remaining item is blocked on the 0034 support window; everything shipped is proved live (the container picker lag under host load is tracked as flake 0710). |
