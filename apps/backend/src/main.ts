#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { OrkestratorBackend } from "./core/index.js";
import { APP_SLUG } from "./core/constants.js";
import { fixPath } from "./core/fix-path.js";
import { OrkestratorGateway } from "./gateway.js";

type Options = {
  dataDir: string;
  appRoot: string;
  resourceRoot: string;
  rendererRoot: string;
  rendererDevServerUrl?: string;
  host?: string;
  port?: number;
  unsafeAllowNonTailscaleBind: boolean;
};

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultDataDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_SLUG);
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), APP_SLUG);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP_SLUG);
}

function parseOptions(args: string[]): Options {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const appRoot = path.resolve(valueAfter(args, "--app-root") ?? process.env.ORKESTRATOR_APP_ROOT ?? sourceRoot);
  const portValue = valueAfter(args, "--port") ?? process.env.ORKESTRATOR_GATEWAY_PORT;
  const port = portValue === undefined ? undefined : Number.parseInt(portValue, 10);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }
  return {
    dataDir: path.resolve(valueAfter(args, "--data-dir") ?? process.env.ORKESTRATOR_DATA_DIR ?? defaultDataDir()),
    appRoot,
    resourceRoot: path.resolve(valueAfter(args, "--resource-root") ?? process.env.ORKESTRATOR_RESOURCE_ROOT ?? appRoot),
    rendererRoot: path.resolve(valueAfter(args, "--renderer-root") ?? process.env.ORKESTRATOR_RENDERER_ROOT ?? path.join(appRoot, "apps", "web", "dist")),
    rendererDevServerUrl: valueAfter(args, "--renderer-dev-server-url") ?? process.env.ORKESTRATOR_RENDERER_DEV_SERVER_URL,
    host: valueAfter(args, "--host"),
    port,
    unsafeAllowNonTailscaleBind: args.includes("--unsafe-allow-non-tailscale-bind"),
  };
}

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
  port: options.port,
  unsafeAllowNonTailscaleBind: options.unsafeAllowNonTailscaleBind,
});

const info = await gateway.start();
if (!info) {
  throw new Error("No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --unsafe-allow-non-tailscale-bind for local development.");
}

// Machine-readable startup contract used by the Electron supervisor and service managers.
process.stdout.write(`${JSON.stringify({ type: "orkestrator-backend-ready", ...info })}\n`);

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
