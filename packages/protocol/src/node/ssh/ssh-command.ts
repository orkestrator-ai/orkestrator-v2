import path from "node:path";
import {
  validateIdentityFile,
  validatePort,
  validateSshDestination,
} from "@orkestrator/protocol/device-catalogue";
import { SshTunnelError } from "./tunnel-failures.js";

/** A saved SSH route as the route manager hands it to the adapter. */
export type SshRouteSpec = {
  routeId: string;
  destination: string;
  sshPort?: number;
  identityFile?: string;
  remoteGatewayPort: number;
};

/** A route after validation; `identityFile` is absolute (`~/` expanded). */
export type ValidatedSshRoute = {
  routeId: string;
  destination: string;
  sshPort?: number;
  identityFile?: string;
  remoteGatewayPort: number;
};

const MAX_ROUTE_ID_LENGTH = 200;

/**
 * Validate every field before anything is spawned (SH-12). Option-looking,
 * URL-shaped or control-character input is rejected here, never passed to ssh.
 */
export function validateSshRoute(spec: SshRouteSpec, homedir: string): ValidatedSshRoute {
  try {
    const routeId = typeof spec.routeId === "string" ? spec.routeId.trim() : "";
    if (!routeId || routeId.length > MAX_ROUTE_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(routeId)) {
      throw new Error("The SSH route ID is not valid.");
    }
    const route: ValidatedSshRoute = {
      routeId,
      destination: validateSshDestination(spec.destination),
      remoteGatewayPort: validatePort(spec.remoteGatewayPort, "remote gateway port"),
    };
    if (spec.sshPort !== undefined) route.sshPort = validatePort(spec.sshPort, "SSH port");
    const identityFile = validateIdentityFile(spec.identityFile);
    if (identityFile) route.identityFile = expandHomePath(identityFile, homedir);
    return route;
  } catch (error) {
    if (error instanceof SshTunnelError) throw error;
    throw SshTunnelError.of("invalid-route", {
      message: error instanceof Error ? error.message : "The SSH route settings are not valid.",
    });
  }
}

export function expandHomePath(value: string, homedir: string): string {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return path.join(homedir, value.slice(2));
  return value;
}

/** Same comparison key for "is this the same tunnel?" across leases. */
export function routeTunnelKey(route: ValidatedSshRoute): string {
  return JSON.stringify([
    route.destination,
    route.sshPort ?? null,
    route.identityFile ?? null,
    route.remoteGatewayPort,
  ]);
}

function configFileArgs(configFile: string | undefined): string[] {
  return configFile ? ["-F", configFile] : [];
}

function portArgs(route: ValidatedSshRoute): string[] {
  // Never force port 22: an omitted port keeps the alias's configured Port.
  return route.sshPort === undefined ? [] : ["-p", String(route.sshPort)];
}

/** Quote a known_hosts list for `-o UserKnownHostsFile=...` (OpenSSH argv_split). */
export function formatKnownHostsFilesOption(files: readonly string[]): string {
  return files.map((file) => `"${file.replace(/[\\"]/g, (char) => `\\${char}`)}"`).join(" ");
}

/** `ssh -G` reads the effective configuration without connecting. */
export function buildConfigInspectionArgs(
  route: ValidatedSshRoute,
  configFile: string | undefined,
): string[] {
  return [...configFileArgs(configFile), "-G", ...portArgs(route), "--", route.destination];
}

export type TunnelArgsInput = {
  route: ValidatedSshRoute;
  localPort: number;
  /** BatchMode=yes for unattended attempts; no prompts at all (SH-03). */
  batchMode: boolean;
  /** Effective user known_hosts files followed by the Orkestrator-owned file. */
  knownHostsFiles: readonly string[];
  configFile?: string;
};

/**
 * The owned forwarding child. Each element is one argv entry; nothing is ever
 * joined into a shell string, and there is no remote command.
 */
export function buildTunnelArgs(input: TunnelArgsInput): string[] {
  const { route } = input;
  const args = [
    ...configFileArgs(input.configFile),
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    // VERBOSE adds the "Authenticated to" line readiness waits for, so a probe
    // never mistakes an unrelated listener on the port for the forward.
    "-o",
    "LogLevel=VERBOSE",
    "-o",
    `BatchMode=${input.batchMode ? "yes" : "no"}`,
    "-o",
    `UserKnownHostsFile=${formatKnownHostsFilesOption(input.knownHostsFiles)}`,
    ...portArgs(route),
  ];
  if (route.identityFile) {
    args.push("-i", route.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(
    "-L",
    `127.0.0.1:${input.localPort}:127.0.0.1:${route.remoteGatewayPort}`,
    "--",
    route.destination,
  );
  return args;
}

/**
 * Capture the server's host key into a private file without offering any
 * credential: every authentication method is disabled, so the session ends
 * with "Permission denied" right after key exchange.
 */
export function buildHostKeyProbeArgs(
  route: ValidatedSshRoute,
  tempKnownHostsFile: string,
  configFile: string | undefined,
): string[] {
  return [
    ...configFileArgs(configFile),
    "-N",
    "-T",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${formatKnownHostsFilesOption([tempKnownHostsFile])}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "HashKnownHosts=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "PreferredAuthentications=none",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...portArgs(route),
    "--",
    route.destination,
  ];
}
