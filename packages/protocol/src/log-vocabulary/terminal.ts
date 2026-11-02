import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const TERMINAL_LOG_AREAS = defineLogAreas({
  terminal: {
    description:
      "Terminals. The renderer's lines stay in the browser console; the backend's reach the saved log.",
    events: {
      "input.undelivered": "A keystroke did not reach a shell: `no-session` or `not-delivered`.",
      "orphan.reaped": "A terminal no tab references was closed.",
      "agent-completion.notify-failed": "A terminal agent's completion could not be reported.",
      "activity.record-failed": "Terminal environment activity could not be recorded.",
      "pty.exit-listener-failed": "A terminal exit listener threw; the others still run.",
      "pty.exit-notify-failed": "Notifying a terminal's exit failed.",
      "pty.late-exit-listener-failed": "A listener added after a terminal exited threw.",
      "setup.pty-reused": "A setup terminal reused its existing PTY.",
      "setup.pty-spawning":
        "A setup terminal is spawning its PTY. The argument count only, never the arguments.",
      "setup.pty-spawned": "A setup terminal's PTY started.",
      "setup.pty-exited": "A setup terminal's PTY exited.",
      "setup.preparing": "Workspace preparation started in the setup terminal.",
      "setup.session-creating": "A setup session is being created.",
      "setup.intro-emitted": "The setup intro was written to the terminal.",
      "setup.completed": "Setup finished.",
      "setup.failed": "Setup failed.",
      "setup.already-complete": "Setup was requested but had already finished.",
      "setup.renderer-ensured": "The renderer asked for setup to be running.",
      "setup.renderer-requested": "The renderer asked for the setup session.",
      "setup.renderer-requested-none":
        "The renderer asked for a setup session that does not exist.",
      "setup.no-commands": "An environment has no setup commands to run.",
      "setup.already-running": "Setup was requested while it was already running.",
      "setup.held-for-approval": "Setup is held until its commands are approved.",
      "setup.renderer-checked-session":
        "The renderer asked whether a setup terminal session exists.",
      "setup.renderer-requested-buffer":
        "The renderer asked for a setup terminal's output buffer. A size only, never its contents.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
