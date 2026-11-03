# Project Home browser spec fails on hosts whose shell emits OSC context sequences

Found on 2026-11-03 while qualifying
[2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) on beelink.

## Task analysis

Analysed 2026-11-03 against `main` at `4d9ff8690`.

### Tasks

1. **Make the Home terminal check ignore terminal control sequences**: the spec compares raw terminal output to an exact line, which a host's shell can prefix with a control sequence. Status: done (2026-11-03).

### 1. Make the Home terminal check ignore terminal control sequences

**Problem.** `project Home retains background work and unread attention beneath the board` (`e2e/agent-testing/browser-gateway.spec.ts:429`) fails every time on beelink. It polls `get_terminal_output_snapshot` and looks for a line exactly equal to `home-background-finished` (line 493), and that never matches within the 5 s poll.

**Context.** The snapshot is raw terminal output, escape sequences included. The local terminal runs the user's login shell, which on beelink is bash with systemd's `/etc/profile.d/80-systemd-osc-context.sh` (systemd 262.1). That script sets `PS0`, so bash writes an OSC 3008 sequence, with no newline, after a command is read and before it runs. The `sleep 1; printf …` command's output therefore starts on the same line as that sequence.

**Investigation.** Four runs failed at the same assertion: the whole file, alone, alone on a profile with only `--ozone-platform=headless` (the switch `--headless-electron` used before 2181), and alone on a profile with the full headless switches. A temporary log of the last 300 characters of each poll showed the OSC 3008 `type=command` sequence and then the prompt. It did not capture the line holding the printed text, so the prefix on that exact line is inferred from `PS0`'s behaviour and not directly observed. The spec has not been run here with a real display, because that would open a window on the user's desktop. No prompt, terminal or file content was recorded beyond those control sequences.

**Decisions.**

- **Where should the fix go?**
  - **Strip control sequences in the spec before comparing lines (recommended).**
    - Pros: fixes the failure on every host; the assertion still requires the exact line of output.
    - Cons: the spec needs a small escape-stripping helper, or an existing one if the suite has it.
  - **Start the fixture's terminal without the host's profile scripts.**
    - Pros: makes every terminal check independent of the host's shell setup.
    - Cons: changes what the journey exercises, and the local terminal deliberately runs the user's login shell.
  - **Match the text anywhere in the snapshot.**
    - Pros: one line.
    - Cons: the echoed command line contains the same text, so the check could pass before the command has finished.

## Assumptions and decisions

### Task 1: strip the sequences in the spec

The recommended option. `browser-gateway.spec.ts` now compares lines of
`visibleText(output)`, the same stripping `terminal-mobile-panes.spec.ts` and five
other specs already use, so the check still needs the exact line and the echoed
command cannot match it. The case passed in the isolated suite on beelink on
2026-11-03 (about 10 s), on a `--headless` profile.

## Needs verification

- On a host without the systemd script. Only beelink has run the fix.
- Other specs that compare a whole line of `get_terminal_output_snapshot` output may share this failure. None were checked.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found this.
