/**
 * Child process for `acp-process-tree.test.ts`: drives one real `AcpProcess`
 * against an agent that starts a long-lived descendant of its own, closes it,
 * and prints whether that descendant outlived the close as one JSON line.
 *
 * Its own process, because `acp-context.ts` reads the provider configuration at
 * module scope and this agent needs a configuration of its own. It does not
 * call `process.exit`: the test's timeout fails it if the closed child, or a
 * timer, kept this owner's event loop alive.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const agent = `
  const { spawn } = require("node:child_process");
  // A descendant in the agent's own process group, as a terminal or an MCP
  // server would be. Its stdio is detached from the agent's pipes.
  const descendant = spawn(process.execPath, ["-e", \`
    process.on("SIGTERM", () => {});
    process.stdout.write("ready");
    setInterval(() => {}, 1 << 30);
  \`], { stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise(resolve => descendant.stdout.once("data", resolve));
  let input = "";
  process.stdin.on("data", async (data) => {
    input += data;
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const { id } = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    await ready;
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id, result: { leader: process.pid, descendant: descendant.pid } }) + "\\n",
    );
  });
  setInterval(() => {}, 1 << 30);
`;

process.env.ACP_PROVIDER = "tree";
process.env.ACP_PROVIDER_CONFIG = JSON.stringify({
  id: "tree",
  name: "Process tree agent",
  executable: process.execPath,
  argv: ["-e", agent],
  env: {},
  requiresAuthenticate: false,
  modeMap: {},
  extensionPrefixes: [],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: [],
  sessionUpdateMethods: [],
});

const { AcpProcess } = await import("../acp-context.js");
const { termGraceMs } = await import("../acp-process-tree.js");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function exitedWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !alive(pid);
}

if (process.argv.includes("--crash")) {
  // This is the detached group the backend created, containing a bridge and
  // its ACP agent. SIGKILL bypasses every bridge close handler.
  const bridge = spawn(process.execPath, [import.meta.filename, "--bridge"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  bridge.stderr.pipe(process.stderr);
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tree = await new Promise<{ leader: number; descendant: number }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Bridge tree announcement timed out")), 10_000);
      bridge.once("error", reject);
      bridge.stdout.on("data", (data) => {
        output += data;
        let newline: number;
        while ((newline = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          // The bridge may log startup metadata before its tree announcement.
          if (!line.startsWith("{")) continue;
          try {
            const value = JSON.parse(line);
            if (typeof value.leader === "number" && typeof value.descendant === "number") {
              clearTimeout(timer);
              resolve(value);
            }
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    const exited = once(bridge, "exit");
    bridge.kill("SIGKILL");
    await exited;
    const backendCore = new URL("../../../../apps/backend/src/core/", import.meta.url).href;
    const { LocalServerRuntime } = await import(`${backendCore}local-server-runtime.ts`);
    const { reapProcessGroup } = await import(`${backendCore}process-tree.ts`);
    // The runtime's grace is a constant; its reaper is an injection point, so
    // the test shortens only the wait for the TERM-resistant descendant.
    const runtime = new LocalServerRuntime({
      reapProcessGroup: (pgid: number | undefined, options: { graceMs: number }) =>
        reapProcessGroup(pgid, { ...options, graceMs: termGraceMs() }),
    });
    // The real backend reaper must finish before a replacement is admitted.
    await runtime.reapAfterUnrequestedExit("grok:crash-fixture", bridge);
    process.stdout.write(
      JSON.stringify({
        leaderExited: await exitedWithin(tree.leader, 3_000),
        descendantExited: await exitedWithin(tree.descendant, 3_000),
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
    // Only the detached group created above, never a host/ancestor group.
    try {
      process.kill(-bridge.pid!, "SIGKILL");
    } catch {
      /* already empty */
    }
  }
} else {
  const child = new AcpProcess();
  const tree = (await child.request("probe/tree", {}, 10_000)) as {
    leader: number;
    descendant: number;
  };
  if (process.argv.includes("--bridge")) {
    process.stdout.write(JSON.stringify(tree) + "\n");
    // Pipes keep this bridge alive until the parent crash probe kills it.
  } else {
    await child.close();
    const leaderExited = await exitedWithin(tree.leader, 3_000);
    const descendantExited = await exitedWithin(tree.descendant, 3_000);
    if (!descendantExited) {
      try {
        process.kill(tree.descendant, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    process.stdout.write(JSON.stringify({ leaderExited, descendantExited }) + "\n");
  }
}
