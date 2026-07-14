import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { APP_SLUG } from "./core/constants.js";

export const MACOS_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export type BackendOptions = {
  dataDir: string;
  appRoot: string;
  resourceRoot: string;
  rendererRoot: string;
  rendererDevServerUrl?: string;
  host?: string;
  fallbackHost?: string;
  port?: number;
  controlHost?: string;
  controlPort?: number;
  allowNonTailscaleBind: boolean;
  allowedOrigins?: string[];
  tailscaleServe: boolean;
  tailscaleServePort: number;
  tailscaleExecutable: string;
};

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("Orkestrator does not support Windows. Use macOS or Linux.");
  }
}

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
  assertSupportedPlatform(platform);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_SLUG);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), APP_SLUG);
}

export function defaultTailscaleExecutable(
  platform: NodeJS.Platform = process.platform,
  fileExists: (candidate: string) => boolean = existsSync,
): string {
  if (platform === "darwin" && fileExists(MACOS_TAILSCALE_APP_CLI)) {
    return MACOS_TAILSCALE_APP_CLI;
  }
  return "tailscale";
}

function parsePortOption(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || String(port) !== value.trim() || port < 0 || port > 65535) {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  return port;
}

export function parseOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  sourceUrl: string = import.meta.url,
): BackendOptions {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(sourceUrl)), "../../..");
  const appRoot = path.resolve(valueAfter(args, "--app-root") ?? env.ORKESTRATOR_APP_ROOT ?? sourceRoot);
  const portValue = valueAfter(args, "--port") ?? env.ORKESTRATOR_GATEWAY_PORT;
  const port = parsePortOption(portValue, "--port");
  const controlPort = parsePortOption(valueAfter(args, "--control-port"), "--control-port");
  const tailscaleServePort = parsePortOption(
    valueAfter(args, "--tailscale-serve-port") ?? env.ORKESTRATOR_TAILSCALE_SERVE_PORT,
    "--tailscale-serve-port",
  ) ?? 443;
  if (tailscaleServePort === 0) {
    throw new Error("Invalid --tailscale-serve-port value: 0");
  }
  return {
    dataDir: path.resolve(valueAfter(args, "--data-dir") ?? env.ORKESTRATOR_DATA_DIR ?? defaultDataDir(process.platform, env)),
    appRoot,
    resourceRoot: path.resolve(valueAfter(args, "--resource-root") ?? env.ORKESTRATOR_RESOURCE_ROOT ?? appRoot),
    rendererRoot: path.resolve(valueAfter(args, "--renderer-root") ?? env.ORKESTRATOR_RENDERER_ROOT ?? path.join(appRoot, "apps", "web", "dist")),
    rendererDevServerUrl: valueAfter(args, "--renderer-dev-server-url") ?? env.ORKESTRATOR_RENDERER_DEV_SERVER_URL,
    host: valueAfter(args, "--host"),
    fallbackHost: valueAfter(args, "--fallback-host"),
    port,
    controlHost: valueAfter(args, "--control-host"),
    controlPort,
    // "--unsafe-allow-non-tailscale-bind" is the pre-rename spelling; unknown
    // flags are ignored, so dropping it would strand existing service units.
    allowNonTailscaleBind: args.includes("--allow-non-tailscale-bind")
      || args.includes("--unsafe-allow-non-tailscale-bind"),
    allowedOrigins: (valueAfter(args, "--allowed-origins") ?? env.ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS)
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    tailscaleServe: args.includes("--tailscale-serve")
      || env.ORKESTRATOR_TAILSCALE_SERVE === "1",
    tailscaleServePort,
    tailscaleExecutable: valueAfter(args, "--tailscale-bin")
      ?? env.ORKESTRATOR_TAILSCALE_BIN
      ?? defaultTailscaleExecutable(),
  };
}
