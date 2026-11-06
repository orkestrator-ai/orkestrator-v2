# One visible-text helper for terminal snapshots in the agent-testing specs

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from the terminal snapshot
audit in [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 3.

### Tasks

1. **Share one visible-text helper**: replace the agent-testing specs' copies of the terminal visible-text function with one shared export, keeping each spec's assertions as they are. Status: open.

### 1. Share one visible-text helper

**Problem.** The specs that read `get_terminal_output_snapshot` each strip control
sequences with their own copy of a `visibleText` function, and the copies have
drifted. A later spec that copies the weakest one, or a host shell that emits a
sequence only some copies remove, brings back the failure 4741 fixed: a whole-line
comparison that never matches because the line still holds an escape sequence.

**Context.** Copies on 2026-11-06, all in `e2e/agent-testing/`:

- `browser-gateway.spec.ts`, `terminal-input-resume.spec.ts`,
  `terminal-input-resume-electron.spec.ts`, `terminal-mobile-panes.spec.ts`:
  OSC, DCS, CSI and two-character escapes, and C0 controls except `\n` and `\t`.
- `container-root-terminal.spec.ts`, `container-claude-terminal-signal.spec.ts`: the
  same, with the keypad-mode escapes `ESC =` and `ESC >` as well.
- `client-outage.spec.ts`: the same as the first group, but also strips `\t`.
- `local-gateway-transport-stack.ts` (exported, used by
  `local-gateway-transport-electron.spec.ts`) and the in-page copy in
  `local-gateway-transport-cpu-page.ts`: OSC, CSI and C0 only, no DCS or
  two-character escapes.

Every whole-line comparison already goes through one of these
([2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), Current state), so
nothing fails today.

**Investigation.** Put one helper in a shared, non-spec module under
`e2e/agent-testing/` (for example beside `browser-test.ts`) with the union of the
rules: OSC terminated by BEL or ST, DCS, CSI, two-character escapes including
`ESC =` and `ESC >`, and C0 controls other than `\n`. Decide whether `\t` survives;
only `client-outage.spec.ts` drops it, and its `lastLines` filter matches digits
only, so keeping `\t` would not change that spec. Give it a unit test with a
beelink-style OSC 3008 prompt, a DCS string and a keypad escape. The in-page copy
in `local-gateway-transport-cpu-page.ts` runs inside the page as source text, so
it either stays a copy (with a comment naming the shared helper) or is generated
from the helper's source. Run each changed owner afterwards: the browser specs on
a `dev:test --fixture` profile, the Docker specs on a
`--fixture-environments local,container` profile, and the Electron specs only
where a display is available (see agent-testing.md, Electron specs and their
display).

**Decisions.**

- **Where the shared helper lives.**
  - **A plain module in `e2e/agent-testing/` imported by every spec (recommended).**
    - Pros: one rule set; a unit test covers it once.
    - Cons: touches eight files, three of which need Docker or a display to run.
  - **Keep the copies and align their rules.**
    - Pros: no new import.
    - Cons: the copies drift again; nothing stops a new spec copying an old one.
- **The in-page copy.**
  - **Keep it as a copy with a comment pointing at the helper (recommended).**
    - Pros: no build step for page code.
    - Cons: still a second copy, but only one, and named.
  - **Generate it from the helper's `toString()`.**
    - Pros: truly one source.
    - Cons: depends on how the bundler prints the function; fragile.

## Constraints and rationale

Do not change shell startup files to hide OSC output, and keep exact-line
assertions after stripping: matching text anywhere can pass on the echoed command.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 3, the audit
  that found this.
