import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSshAdapterContext,
  type SshAdapterContext,
  type SshChildProcess,
} from "@orkestrator/protocol/node/ssh/context";
import type { ForwardProbeResult } from "@orkestrator/protocol/node/ssh/port-allocation";

let nextPid = 40_000;

/** A fake OpenSSH child: scripted stderr, recorded signals, explicit exit. */
export class FakeChild extends EventEmitter implements SshChildProcess {
  readonly pid = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  /** Signals the fake ignores (to exercise SIGTERM -> SIGKILL escalation). */
  ignore = new Set<NodeJS.Signals>();

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    if (!this.ignore.has(signal)) setImmediate(() => this.exit(null, signal));
    return true;
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  writeStdout(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  get alive(): boolean {
    return this.exitCode === null && this.signalCode === null;
  }

  get isTunnel(): boolean {
    return this.args.includes("-L");
  }

  get isConfigInspection(): boolean {
    return this.args.includes("-G");
  }
}

export type FakeSpawnHandler = (child: FakeChild) => void;

export type FakeHarness = {
  context: SshAdapterContext;
  children: FakeChild[];
  tunnels: () => FakeChild[];
  allocatedPorts: number[];
  tmpdir: string;
  knownHostsFile: string;
  cleanup: () => void;
};

export const DEFAULT_SSH_G_OUTPUT = [
  "user alice",
  "hostname build.example.test",
  "port 2222",
  "userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2",
  "controlmaster false",
  "controlpath none",
  "permitlocalcommand no",
  "",
].join("\n");

/** Default tunnel behaviour: authenticate, then stay up. */
export const authenticatedTunnel: FakeSpawnHandler = (child) => {
  setImmediate(() =>
    child.writeStderr('Authenticated to build.example.test ([10.0.0.2]:2222) using "publickey".\n'),
  );
};

export function createFakeHarness(
  options: {
    onTunnel?: FakeSpawnHandler;
    onOther?: FakeSpawnHandler;
    sshGOutput?: string;
    probe?: (port: number) => ForwardProbeResult | Promise<ForwardProbeResult>;
    overrides?: Partial<SshAdapterContext>;
  } = {},
): FakeHarness {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "ork-ssh-test-"));
  const knownHostsFile = path.join(tmpdir, "userData", "ssh", "known_hosts");
  const children: FakeChild[] = [];
  const allocatedPorts: number[] = [];
  let port = 51_000;
  const context = createSshAdapterContext({
    knownHostsFile,
    overrides: {
      tmpdir,
      homedir: "/home/alice",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/alice" },
      platform: "darwin",
      locateBinaries: async () => ({
        ok: true,
        binaries: { ssh: "/usr/bin/ssh", sshKeygen: "/usr/bin/ssh-keygen" },
      }),
      allocatePort: async () => {
        port += 1;
        allocatedPorts.push(port);
        return port;
      },
      probeForward: async (probePort) => (options.probe ? options.probe(probePort) : "open"),
      spawn: (command, args, spawnOptions) => {
        const child = new FakeChild(command, args, (spawnOptions.env ?? {}) as NodeJS.ProcessEnv);
        children.push(child);
        if (child.isConfigInspection) {
          setImmediate(() => {
            child.writeStdout(options.sshGOutput ?? DEFAULT_SSH_G_OUTPUT);
            child.exit(0);
          });
        } else if (child.isTunnel) {
          (options.onTunnel ?? authenticatedTunnel)(child);
        } else {
          options.onOther?.(child);
        }
        return child;
      },
      ...options.overrides,
    },
  });
  return {
    context,
    children,
    tunnels: () => children.filter((child) => child.isTunnel),
    allocatedPorts,
    tmpdir,
    knownHostsFile,
    cleanup: () => rmSync(tmpdir, { recursive: true, force: true }),
  };
}

export const FAST_TIMINGS = { readyTimeoutMs: 1_000, terminateGraceMs: 40, maxPortAttempts: 3 };

export const ROUTE = {
  routeId: "route-a",
  destination: "build-machine",
  remoteGatewayPort: 34_121,
};

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
