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
const agent = `
  const { spawn } = require("node:child_process");
  // A descendant in the agent's own process group, as a terminal or an MCP
  // server would be. Its stdio is detached from the agent's pipes.
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
  });
  let input = "";
  process.stdin.on("data", (data) => {
    input += data;
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const { id } = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
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

const child = new AcpProcess();
const tree = (await child.request("probe/tree", {}, 10_000)) as {
  leader: number;
  descendant: number;
};
await child.close();
const leaderExited = await exitedWithin(tree.leader, 3_000);
const descendantExited = await exitedWithin(tree.descendant, 3_000);
// Never leave the descendant behind if the close did not reach it. It is the
// pid this agent just reported for a process it started itself.
if (!descendantExited) {
  try {
    process.kill(tree.descendant, "SIGKILL");
  } catch {
    // Already gone.
  }
}
process.stdout.write(JSON.stringify({ leaderExited, descendantExited }) + "\n");
