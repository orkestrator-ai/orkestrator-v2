# One visible-text helper for terminal snapshots in the agent-testing specs

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from the terminal snapshot
audit in [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 3.
Updated 2026-11-10 against `main` at `04639b12b`: the helper is shared; live
runs of the owners that need Docker or a display remain.

### Tasks

1. **Share one visible-text helper**: replace the agent-testing specs' copies of the terminal visible-text function with one shared export, keeping each spec's assertions as they are. Status: open (code done 2026-11-10; live runs of the Docker, display and outage owners remain).

### 1. Share one visible-text helper

**Problem.** The specs that read `get_terminal_output_snapshot` each stripped
control sequences with their own copy of a `visibleText` function, and the
copies had drifted. A later spec that copied the weakest one, or a host shell
that emits a sequence only some copies removed, would bring back the failure
4741 fixed: a whole-line comparison that never matches because the line still
holds an escape sequence.

**Context.** Copies on 2026-11-06, all in `e2e/agent-testing/`:

- `browser-gateway.spec.ts`, `terminal-input-resume.spec.ts`,
  `terminal-input-resume-electron.spec.ts`, `terminal-mobile-panes.spec.ts`:
  OSC, DCS, CSI and two-character escapes, and C0 controls except `\n` and `\t`.
- `container-root-terminal.spec.ts`, `container-claude-terminal-signal.spec.ts`
  and (found 2026-11-10) `container-terminal-close.spec.ts`: the same, with the
  keypad-mode escapes `ESC =` and `ESC >` as well.
- `client-outage.spec.ts`: the same as the first group, but also strips `\t`.
- `local-gateway-transport-stack.ts` (exported, used by
  `local-gateway-transport-electron.spec.ts`) and the in-page copy in
  `local-gateway-transport-cpu-page.ts`: OSC, CSI and C0 only, no DCS or
  two-character escapes.

**Investigation.** Done 2026-11-10. `e2e/agent-testing/terminal-visible-text.ts`
exports `terminalVisibleText` and its rules, `TERMINAL_ESCAPE_PATTERNS`, applied
in order: OSC ended by BEL or ST, DCS, CSI, escapes with intermediate bytes,
two-character escapes, then C0 controls and DEL other than `\n` and `\t`. All
nine copies are gone; every caller imports the helper and its assertions are
unchanged (whole lines after stripping).

The union of the copies still let two things through, which the unit test's
samples exposed, so the rules go one step further than the union:

- Every copy matched two-character escapes as `ESC [@-_]` (some adding `=` and
  `>`), so `ESC 7` and `ESC 8` (save and restore cursor) left `7` and `8` in
  the text. The helper takes every final byte `0` to `~`.
- `ESC ( B`, which `tput sgr0` emits, matched nothing; the later C0 rule then
  removed only the `ESC` and left `(B`. The helper removes escapes with
  intermediate bytes (`ESC [ -/]+ [0-~]`).

`\t` survives: only `client-outage.spec.ts` dropped it, and its `lastLines`
filter keeps lines of digits only, so keeping it changes nothing there.

`e2e/agent-testing/terminal-visible-text.test.ts` (default tier, in
`ROOT_TEST_PATHS`) covers a beelink-style prompt with OSC 3008 marks and a
title, a DCS string, keypad modes, cursor save and restore, a charset
selection, CSI sequences and C0 controls. It checks that the page copy strips
exactly what the helper strips and that `waitCode` embeds it, and fails when
any other file in `e2e/agent-testing/` holds a copy of the OSC rule, in code or
as page source.

Live runs on beelink2, 2026-11-10, on a disposable `dev:test --fixture
--headless --no-agent-credentials --agent-platforms codex` profile (stopped and
reset afterwards):

- `terminal-input-resume.spec.ts`: 3 passed. All three cases compare terminal
  snapshots through the helper.
- `terminal-mobile-panes.spec.ts`: failed twice at the same step, before any
  snapshot is read. The session running the run had no access to the Docker
  socket (`docker info`: permission denied), so the app opened its blocking
  "Docker Permission Required" dialog over the sidebar.
- `browser-gateway.spec.ts:443` (the helper's one use there): timed out
  finding the fixture project's row, the same environment.
- `client-outage.spec.ts`: skipped; it needs
  `ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1`.
- The Docker specs (`container-root-terminal`, `container-claude-terminal-signal`,
  `container-terminal-close`) and the Electron ones
  (`terminal-input-resume-electron`, `local-gateway-transport-electron`) were not
  run: no Docker access in this session, and those Electron specs need a
  display, which this ticket did not allow.
- `playwright test --list` loads every changed spec in both the browser and
  Electron configs.

**Decisions.**

- **Where the shared helper lives.**
  - **A plain module in `e2e/agent-testing/` imported by every spec (recommended, done).**
    - Pros: one rule set; a unit test covers it once.
    - Cons: touches nine files, five of which need Docker or a display to run.
  - **Keep the copies and align their rules.**
    - Pros: no new import.
    - Cons: the copies drift again; nothing stops a new spec copying an old one.
- **The in-page copy.**
  - **Generate it from the helper's patterns with `RegExp.prototype.toString` (chosen).**
    - Pros: truly one source; the language defines a pattern's printed form,
      so it does not depend on how a bundler prints a function; the unit test
      evaluates it against the helper.
    - Cons: page source assembled from strings.
  - **Keep it as a copy with a comment pointing at the helper (the 2026-11-06 recommendation).**
    - Pros: no generated page code.
    - Cons: still a second copy that can drift.
  - **Generate it from the helper's `toString()`.**
    - Pros: one source.
    - Cons: depends on how the bundler prints the function; fragile.

## Outstanding work

Run the owners that need Docker, a display or the outage opt-in, and the two
that the missing Docker access blocked, on a host whose session can reach
Docker:

- `terminal-mobile-panes.spec.ts` and `browser-gateway.spec.ts:443` on a
  `dev:test --fixture` profile;
- `client-outage.spec.ts` with `ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1`;
- `container-root-terminal.spec.ts`, `container-claude-terminal-signal.spec.ts`
  and `container-terminal-close.spec.ts` on a
  `--fixture-environments local,container` profile
  (`mise run test:agent:docker`);
- `terminal-input-resume-electron.spec.ts` and
  `local-gateway-transport-electron.spec.ts` with a disposable display (see
  agent-testing.md, Electron specs and their display); the host for that waits
  on 7568: 6303 task 2.

Close this file when they pass.

## Assumptions and decisions

### Task 1: rules wider than the union of the copies (2026-11-10)

The to-do asked for the union. The helper also removes `ESC 7`/`ESC 8` and
other two-character escapes with a final byte outside `@-_`, and escapes with
intermediate bytes such as `ESC ( B`. None of them is ever visible text, so
stripping them can only make a whole-line comparison match where it should,
and the copies' rules left visible debris for both.

### Task 1: the in-page copy is generated, not hand-kept (2026-11-10)

See the decision above. The generated source is checked by evaluating it in
the unit test, which removes the fragility the 2026-11-06 analysis worried
about.

### Task 1: the copy check lives in the unit test (2026-11-10)

A text search in `terminal-visible-text.test.ts` for the OSC rule, rather than
a new source guard: the copies were all in one directory, and the rule's text
is distinctive. It catches a copy in code and in page source.

## Constraints and rationale

Do not change shell startup files to hide OSC output, and keep exact-line
assertions after stripping: matching text anywhere can pass on the echoed command.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 3, the audit
  that found this.
