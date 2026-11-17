import type { TmuxSession } from "./tmux-session-manager.js";
import { spawnPty, type PtyProcess } from "./pty.js";

/** Only clipboard escapes leave this client; screen output remains snapshot-based. */
export class TmuxClipboardParser {
  private pending = "";
  private state: "text" | "escape" | "osc" | "osc-escape" = "text";
  private oversized = false;
  constructor(private readonly emit: (sequence: string) => void) {}

  write(chunk: string): void {
    for (const char of chunk) {
      if (this.state === "text") {
        if (char === "\x1b") this.state = "escape";
      } else if (this.state === "escape") {
        this.state = char === "]" ? "osc" : char === "\x1b" ? "escape" : "text";
        this.pending = "";
        this.oversized = false;
      } else if (char === "\x07" || (this.state === "osc-escape" && char === "\\")) {
        if (!this.oversized && this.pending.startsWith("52;")) {
          this.emit(`\x1b]${this.pending}\x07`);
        }
        this.pending = "";
        this.state = "text";
      } else if (char === "\x1b") {
        this.state = "osc-escape";
      } else {
        if (this.state === "osc-escape") {
          this.pending = "";
          this.oversized = true;
        }
        this.state = "osc";
        if (!this.oversized) {
          if (this.pending.length >= 4 * 1024 * 1024 + 32) {
            this.pending = "";
            this.oversized = true;
          } else this.pending += char;
        }
      }
    }
  }
}

/** Decode only the raw bytes for the attached pane from tmux control mode. */
export class TmuxClipboardControlParser {
  private line = "";
  private oversized = false;
  constructor(
    private readonly pane: string,
    private readonly parser: TmuxClipboardParser,
  ) {}
  write(chunk: string): void {
    for (const char of chunk) {
      if (char === "\n") {
        const prefix = `%output ${this.pane} `;
        if (!this.oversized && this.line.startsWith(prefix)) {
          this.parser.write(
            this.line
              .slice(prefix.length)
              .replace(/\\([0-7]{3})/g, (_match, octal: string) =>
                String.fromCharCode(Number.parseInt(octal, 8)),
              ),
          );
        }
        this.line = "";
        this.oversized = false;
      } else if (!this.oversized) {
        // tmux octal escaping can expand each raw byte to four characters.
        if (this.line.length >= 16 * 1024 * 1024 + 128) {
          this.line = "";
          this.oversized = true;
        } else if (char !== "\r") this.line += char;
      }
    }
  }
}

/** Owned output-only clients; stopping them detaches, never stops the agent pane. */
export async function attachTmuxClipboard(
  session: TmuxSession,
  cols: number,
  rows: number,
  emit: (sequence: string) => void,
  onExit?: () => void,
): Promise<{ dispose(): void }> {
  const pane = await session.backend.exec([
    "tmux",
    "display-message",
    "-p",
    "-t",
    session.tmuxSession,
    "#{pane_id}",
  ]);
  if (pane.status !== 0 || !/^%[0-9]+$/.test(pane.stdout.trim()))
    throw new Error("tmux clipboard pane unavailable");
  const backend = session.backend;
  const spawn = (args: string[]): PtyProcess => {
    if (backend.kind === "local") {
      return spawnPty("tmux", args, {
        cwd: backend.cwd,
        cols,
        rows,
        env: { ...process.env, TERM: "xterm-256color", TMUX: "" },
      });
    }
    if (!backend.containerId) throw new Error("tmux clipboard container missing");
    return spawnPty(
      "docker",
      [
        "exec",
        "-it",
        "-u",
        "node",
        "-w",
        "/workspace",
        backend.containerId,
        "env",
        "TERM=xterm-256color",
        "TMUX=",
        "tmux",
        ...args,
      ],
      { cols, rows },
    );
  };
  // The terminal client receives load-buffer -w. Control mode preserves raw
  // pane OSC and DCS even with set-clipboard=external / allow-passthrough=off.
  // Neither client changes server-wide clipboard policy or window options.
  // tmux read-only would also refuse the existing backend send-keys path;
  // these handles expose no write method and never send input to the clients.
  const args = ["attach-session", "-f", "ignore-size", "-E", "-t", session.tmuxSession];
  const newOutput = new TmuxClipboardParser(emit);
  const clients: PtyProcess[] = [];
  const listeners: Array<{ dispose(): void }> = [];
  const ready = (client: PtyProcess, control: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      let tail = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        data?.dispose();
        exit?.dispose();
        if (error) reject(error);
        else resolve();
      };
      let data: { dispose(): void } | undefined;
      let exit: { dispose(): void } | undefined;
      const timer = setTimeout(() => finish(new Error("tmux clipboard attach timed out")), 10_000);
      data = client.onData((chunk) => {
        tail += chunk;
        if (control ? /%end [^\r\n]+[\r\n]/.test(tail) : tail.includes("\x1b[?1049h")) finish();
        tail = tail.slice(-256);
      });
      exit = client.onExit(() => finish(new Error("tmux clipboard client exited")));
      if (settled) {
        data.dispose();
        exit.dispose();
      }
    });
  try {
    const control = spawn(["-C", ...args]);
    clients.push(control);
    const parser = new TmuxClipboardControlParser(
      pane.stdout.trim(),
      new TmuxClipboardParser(emit),
    );
    listeners.push(control.onData((data) => parser.write(data)));
    await ready(control, true);
    // load-buffer -w targets the most recently attached client. Attach the
    // terminal last, after the control client's registration is confirmed.
    const output = spawn(["-T", "clipboard", ...args]);
    clients.push(output);
    listeners.push(output.onData((data) => newOutput.write(data)));
    await ready(output, false);
  } catch (error) {
    for (const client of clients) client.kill();
    throw error;
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const listener of listeners) listener.dispose();
    for (const client of clients) client.kill();
  };
  for (const client of clients)
    listeners.push(
      client.onExit(() => {
        if (disposed) return;
        dispose();
        onExit?.();
      }),
    );
  return { dispose };
}
