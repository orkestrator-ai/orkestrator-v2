#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { OrkestratorBackend } from "./core/index.js";
import { fixPath } from "./core/fix-path.js";
import { OrkestratorGateway } from "./gateway.js";
import { parseOptions } from "./options.js";

fixPath();
const options = parseOptions(process.argv.slice(2));
await mkdir(options.dataDir, { recursive: true });

let gateway: OrkestratorGateway;
const backend = new OrkestratorBackend({
  dataDir: options.dataDir,
  appRoot: options.appRoot,
  resourceRoot: options.resourceRoot,
  emit: (event, payload) => gateway?.emit(event, payload),
});
await backend.init();

gateway = new OrkestratorGateway({
  backend,
  dataDir: options.dataDir,
  rendererRoot: options.rendererRoot,
  rendererDevServerUrl: options.rendererDevServerUrl,
  bindAddress: options.host,
  fallbackBindAddress: options.fallbackHost,
  port: options.port,
  unsafeAllowNonTailscaleBind: options.unsafeAllowNonTailscaleBind,
});

const info = await gateway.start();
if (!info) {
  throw new Error("No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --unsafe-allow-non-tailscale-bind for local development.");
}

// Machine-readable startup contract used by the Electron supervisor and service managers.
// Authentication material stays in the mode-0600 auth file and must never enter logs.
process.stdout.write(`${JSON.stringify({
  type: "orkestrator-backend-ready",
  bindAddress: info.bindAddress,
  port: info.port,
  url: info.url,
  authFile: info.authFile,
})}\n`);

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
