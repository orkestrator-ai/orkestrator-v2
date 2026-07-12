import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { APP_SLUG } from "./core/constants.js";

export type BackendOptions = {
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
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_SLUG);
  if (platform === "win32") return path.join(env.APPDATA ?? home, APP_SLUG);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), APP_SLUG);
}

export function parseOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  sourceUrl: string = import.meta.url,
): BackendOptions {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(sourceUrl)), "../../..");
  const appRoot = path.resolve(valueAfter(args, "--app-root") ?? env.ORKESTRATOR_APP_ROOT ?? sourceRoot);
  const portValue = valueAfter(args, "--port") ?? env.ORKESTRATOR_GATEWAY_PORT;
  let port: number | undefined;
  if (portValue !== undefined) {
    port = Number.parseInt(portValue, 10);
    if (!Number.isInteger(port) || String(port) !== portValue.trim() || port < 0 || port > 65535) {
      throw new Error(`Invalid --port value: ${portValue}`);
    }
  }
  return {
    dataDir: path.resolve(valueAfter(args, "--data-dir") ?? env.ORKESTRATOR_DATA_DIR ?? defaultDataDir(process.platform, env)),
    appRoot,
    resourceRoot: path.resolve(valueAfter(args, "--resource-root") ?? env.ORKESTRATOR_RESOURCE_ROOT ?? appRoot),
    rendererRoot: path.resolve(valueAfter(args, "--renderer-root") ?? env.ORKESTRATOR_RENDERER_ROOT ?? path.join(appRoot, "apps", "web", "dist")),
    rendererDevServerUrl: valueAfter(args, "--renderer-dev-server-url") ?? env.ORKESTRATOR_RENDERER_DEV_SERVER_URL,
    host: valueAfter(args, "--host"),
    port,
    unsafeAllowNonTailscaleBind: args.includes("--unsafe-allow-non-tailscale-bind"),
  };
}
