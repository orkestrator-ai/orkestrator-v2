# Pre-existing problems found on 2026-10-14

Status: Active — none fixed yet.

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
| [05](05-real-stack-suite-host-dependencies.md) | Browser, root and bridge suites fail on an ordinary developer machine for host reasons | Medium | Test infrastructure |
| [06](06-opencode-auth-status-truncation.md) | OpenCode shows "needs auth" while a provider is connected | Low–medium | OpenCode capabilities |

01, 04 and 06 share one underlying weakness: OpenCode model and provider
state is chosen without OpenCode's connectivity report, and
`provider.list().default` is parsed with the wrong shape. Fixing 01's root
cause 5 first makes 04 smaller.

Each file gives the symptom, root cause with file and line references, user
impact, a proposed fix and the tests that pin current behaviour. Line numbers
are as of `d4dfa11d` plus the branch above. Re-check them before editing.
