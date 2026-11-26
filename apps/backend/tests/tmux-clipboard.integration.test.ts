import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Terminal } from "@xterm/xterm";
import { InteractiveTmuxTerminalManager } from "../src/core/tmux/interactive";
import { TmuxBackend } from "../src/core/tmux/backend";
import type { TmuxSession } from "../src/core/tmux/session-manager";
import type { CommandContext } from "../src/core/commands/context";
import { eventSink } from "../src/core/backend-emit";
import {
  bindOsc52ClipboardGestures,
  installOsc52ClipboardHandler,
} from "../../web/src/lib/terminal-osc52";
import { waitFor } from "./tmux-test-harness";

// An exclusive tmux socket, never the developer's server. The wrapper supplies
// the socket to both the real session backend and its owned attached client.
test("real tmux OSC, passthrough and load-buffer copies reach the renderer through the interactive manager", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osc52-"));
  const socket = join(dir, "s");
  const tmux = Bun.which("tmux");
  if (!tmux) throw new Error("tmux is required for this integration test");
  await writeFile(join(dir, "tmux"), `#!/bin/sh\nexec '${tmux}' -S '${socket}' "$@"\n`, {
    mode: 0o700,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  const backend = TmuxBackend.local(dir);
  const manager = new InteractiveTmuxTerminalManager();
  const terminal = new Terminal();
  const writes: string[] = [];
  let gesture: ((event: Event) => void) | undefined;
  installOsc52ClipboardHandler(terminal, {
    writeText: async (text) => {
      writes.push(text);
    },
  });
  bindOsc52ClipboardGestures(terminal, {
    addEventListener: (type: string, handler: (event: Event) => void) => {
      if (type === "keydown") gesture = handler;
    },
    removeEventListener() {},
  } as unknown as HTMLElement);
  const emit = eventSink((_event, payload) => {
    const output = payload as { text: string };
    terminal.write(output.text);
  });
  const context = {
    emit,
    runtime: { environments: { fence: { beginAgentWork: () => () => {} } } },
  } as unknown as CommandContext;
  const exec = async (...args: string[]) => {
    const result = await backend.exec(["tmux", ...args]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  try {
    await exec(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "copy",
      "-x",
      "80",
      "-y",
      "24",
      "/bin/sh",
    );
    const session = {
      backend,
      tmuxSession: "copy",
      environmentId: "fixture",
      tabId: "copy",
      capturePane: async () => exec("capture-pane", "-p", "-e", "-t", "copy"),
      resize: async () => {},
      writeInteractive: async (data: string) => {
        await exec("send-keys", "-t", "copy", "-l", data);
      },
    } as unknown as TmuxSession;
    const id = manager.create(session, 80, 24);
    await manager.start(id, context);
    await waitFor(
      async () =>
        (await exec("list-clients", "-F", "#{client_pid}")).trim().split("\n").length === 2,
    );
    // No server-wide clipboard or passthrough configuration is changed.
    expect((await exec("show-options", "-sv", "set-clipboard")).trim()).toBe("external");
    expect((await exec("show-options", "-gwv", "allow-passthrough")).trim()).toBe("off");
    await writeFile(join(dir, "copy.txt"), "load-buffer");
    gesture?.({ isTrusted: true } as Event);
    await exec("load-buffer", "-w", join(dir, "copy.txt"));
    await waitFor(() => writes.includes("load-buffer"));
    await manager.write(id, "printf '\\033]52;c;cGFuZQ==\\007'\n", context);
    await waitFor(() => writes.includes("pane"));
    await manager.write(
      id,
      "printf '\\033Ptmux;\\033\\033]52;c;cGFzc3Rocm91Z2g=\\007\\033\\\\'\n",
      context,
    );
    await waitFor(() => writes.includes("passthrough"));
    const snapshot = await exec("capture-pane", "-p", "-e", "-t", "copy");
    expect(snapshot).not.toContain("\x1b]52;");
    manager.detach(id);
    await waitFor(async () => (await exec("list-clients", "-F", "#{client_pid}")).trim() === "");
    expect(await exec("has-session", "-t", "copy")).toBe("");
  } finally {
    manager.detachAll();
    terminal.dispose();
    await backend.exec(["tmux", "kill-server"]);
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
