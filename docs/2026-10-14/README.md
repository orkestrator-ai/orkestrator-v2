# Pre-existing problems found on 2026-10-14

Status: Active — 05 resolved (its move case waits on 02); the others are open.

These came out of validating the OpenCode boundary cleanup branch
(`opencode-bridge-a8c2ab5c85b9-r1`): live OpenCode QA in a `dev:test` profile,
the real-stack browser suite and the full `mise run test`. Each problem was
checked against the base commit `d4dfa11d` or traced to code that branch does
not touch, so none of them is a regression from that work.

| # | Problem | Severity | Area |
| --- | --- | --- | --- |
| [01](01-opencode-default-model-not-connected.md) | OpenCode defaults to `opencode/claude-sonnet-5` even when its provider is not connected; the first prompt and every model-less OpenCode build are rejected | High | Backend model defaults, pipelines, renderer composer |
| [02](02-tmux-3-8-no-server-detection.md) | tmux 3.8's new "no server" wording is read as failed cleanup; environment move fails, deletion leaves files | High | Backend tmux cleanup |
| [03](03-startup-claude-login-dialog.md) | "Claude Code Login Required" blocks the whole app when `claude` is unauthenticated and OpenCode is absent, ignoring Codex, Cursor, Grok and Pi; it also breaks the isolated browser suite | High | Renderer startup gate, host tool checks |
| [04](04-opencode-fork-loses-model.md) | A forked OpenCode session switches to the first catalogue model | Medium | Fork flow, composer inference |
| [05](05-real-stack-suite-host-dependencies.md) | Resolved 2026-10-15: browser, root and bridge suites no longer fail for host reasons, and panes survive the mobile breakpoint; the environment move spec waits on 02, and `test:browser` is blocked by a `bun:sqlite` import from #969 | Medium | Test infrastructure, renderer shell |
| [06](06-opencode-auth-status-truncation.md) | OpenCode shows "needs auth" while a provider is connected | Low–medium | OpenCode capabilities |
| [07](07-cleanup-follow-ups.md) | Leftover dead renderer helpers, store consolidation, doc drift, a decision to confirm, a known version-skew limitation, the day's flakes (0207, 0208), a live OpenCode spec to commit, and a fault-isolation watch item | Low | Cleanup and follow-ups |

01, 04 and 06 share one underlying weakness: OpenCode model and provider
state is chosen without OpenCode's connectivity report, and
`provider.list().default` is parsed with the wrong shape. Fixing 01's root
cause 5 first makes 04 smaller.

Each file gives the symptom, root cause with file and line references, user
impact, a proposed fix and the tests that pin current behaviour. Line numbers
are as of `d4dfa11d` plus the branch above. Re-check them before editing.

## Not yet confirmed

These points are inferred and should be checked first when picking up the
item:

- 03: why `dev:test --credential-source claude` still reported Claude as "not
  configured" (`~/.claude.json` not visible to the isolated backend, or not
  imported).
- 04: that "MiMo-V2.6-Pro" is simply the first catalogue row (inferred from
  the label, not checked against OpenCode's provider order).
- 05: confirmed 2026-10-15. The dialog failure is the 768px mobile-shell
  remount; the copy helper and firewall failures come from bsdtar and BSD
  `date`.
- 06: that the connected provider really sits beyond index 127 of
  `provider.list().all` (the provider count in a live response was not
  measured).
