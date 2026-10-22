# CLI and slash commands

The public `orkestrator` CLI and the slash-command catalogue: missing features, catalogue cleanup and live qualification.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0014-cli-qualification.md](0014-cli-qualification.md) | Medium | No | Make Pi, Cursor and Grok qualifiable for request-specific completion; missing live, macOS and Docker Desktop CLI evidence. Holds the CLI evidence log. | Pi, Cursor and Grok cannot be qualified through the CLI yet, and two settle paths leave a request pending until the wait expires. |
| 2 | [0015-slash-command-qualification.md](0015-slash-command-qualification.md) | Medium | No | Live provider probes at current pins, the inactive-environment browser scenario, container paths, mixed versions and performance. | Container paths, mixed versions and catalogue performance are unproven for slash commands. |
| 3 | [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) | Medium | No | Retire the legacy command-catalogue routes; decide the deliberately unavailable command classes (Claude session-changing commands, Codex inline-shell templates, Pi UI extensions). | The legacy catalogue routes and the old-bridge fallback that shows guessed rows still need retiring. |
| 4 | [0017-cli-command-surface.md](0017-cli-command-surface.md) | Medium | No | CLI features left out of the first release: selected slash commands, enqueue, attachments, cascade remove, local init, event following, worker credentials. | CLI features left out of the first release (slash commands, enqueue, attachments, worker credentials); functional gaps, not defects. |
