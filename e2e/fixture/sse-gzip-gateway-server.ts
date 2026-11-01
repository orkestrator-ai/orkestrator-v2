/** Disposable real gateway in `--compression on` for the browser gzip SSE scenario. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrkestratorGateway } from "../../apps/backend/src/gateway";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-sse-gzip-browser-"));
const token = randomBytes(24).toString("hex");
await writeFile(path.join(dataDir, "index.html"), "<!doctype html><title>SSE gzip</title>");
const gateway: OrkestratorGateway = new OrkestratorGateway({
  backend: {
    invoke: async (command, args) => {
      if (command === "emit_frame") gateway.emit("sse-gzip-frame", { id: String(args?.id) });
      return null;
    },
  },
  dataDir,
  rendererRoot: dataDir,
  bindAddress: "127.0.0.1",
  port: 0,
  compression: "on",
  keepaliveMs: 250,
  agentTestMode: true,
  allowNonTailscaleBind: true,
  env: { ORKESTRATOR_GATEWAY_TOKEN: token },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
try {
  const info = await gateway.start();
  if (!info) throw new Error("Gateway failed to start");
  const url = new URL(info.url).origin;
  const response = await fetch(`${url}/__orkestrator/agent-test/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const { code } = (await response.json()) as { code: string };
  if (!code) throw new Error("Gateway bootstrap failed");
  const login = `${url}/__orkestrator/agent-test/login?code=${encodeURIComponent(code)}`;
  // Only the parent test reads this single-use login link. Never log credentials.
  process.stdout.write(`${JSON.stringify({ url, login })}\n`);
  // Parent closes stdin, including on a failed assertion. No process scan or kill.
  for await (const _chunk of Bun.stdin.stream()) {
    /* wait for parent EOF */
  }
} finally {
  await gateway.stop();
  await rm(dataDir, { recursive: true, force: true });
}
