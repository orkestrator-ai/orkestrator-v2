/** Disposable real gateway for the data-saving browser scenario; synthetic backend only. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { OrkestratorGateway } from "../../apps/backend/src/gateway";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-data-saving-browser-"));
const token = randomBytes(24).toString("hex");
let state = { revision: 0, state: "working", emittedAt: 0 };
const gateway = new OrkestratorGateway({
  backend: {
    invoke: async (command, args) => {
      if (command === "baseline_read") return { ...state, padding: "synthetic".repeat(200) };
      if (command === "baseline_publish") {
        state = { revision: state.revision + 1, state: String(args?.state), emittedAt: Date.now() };
        gateway.emit("baseline-update", { revision: state.revision });
        return state;
      }
      return null;
    },
  },
  dataDir,
  rendererRoot: dataDir,
  rendererDevServerUrl: process.argv[2],
  bindAddress: "127.0.0.1",
  port: 0,
  agentTestMode: true,
  allowNonTailscaleBind: true,
  env: { ORKESTRATOR_GATEWAY_TOKEN: token },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
try {
  const info = await gateway.start();
  if (!info) throw new Error("Gateway failed to start");
  const url = new URL(info.url).origin;
  const logins: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${url}/__orkestrator/agent-test/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const { code } = (await response.json()) as { code: string };
    if (!code) throw new Error("Gateway bootstrap failed");
    logins.push(`${url}/__orkestrator/agent-test/login?code=${encodeURIComponent(code)}`);
  }
  // Only the parent test reads these single-use login links. Never log credentials.
  process.stdout.write(`${JSON.stringify({ url, logins })}\n`);
  // Parent closes stdin, including on a failed assertion. No process scan or kill.
  for await (const _chunk of Bun.stdin.stream()) {
    /* wait for parent EOF */
  }
} finally {
  await gateway.stop();
  await rm(dataDir, { recursive: true, force: true });
}
