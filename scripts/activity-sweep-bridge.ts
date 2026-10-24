import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type BridgeKind = "codex" | "claude";

export interface RunningBridge {
  kind: BridgeKind;
  child: ChildProcess;
  baseUrl: string;
  token: string;
  home: string;
  exited: Promise<void>;
}

interface BridgeStartupOptions {
  root: string;
  codex: string;
}

interface BridgeStartupDependencies {
  spawn: typeof spawn;
  fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  credentialPath: string;
  tempRoot: string;
  readinessAttempts: number;
  pollMs: number;
  stopBudgetMs: number;
}

export async function startBridge(
  kind: BridgeKind,
  options: BridgeStartupOptions,
  dependencies: Partial<BridgeStartupDependencies> = {},
): Promise<RunningBridge> {
  const deps: BridgeStartupDependencies = {
    spawn,
    fetch,
    credentialPath: join(homedir(), ".codex", "auth.json"),
    tempRoot: tmpdir(),
    readinessAttempts: 300,
    pollMs: 100,
    stopBudgetMs: 500,
    ...dependencies,
  };
  const home = mkdtempSync(join(deps.tempRoot, `activity-sweep-${kind}-`));
  let bridge: RunningBridge | undefined;
  try {
    chmodSync(home, 0o700);
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const token = randomBytes(24).toString("base64url");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CWD: workspace,
    };
    // An inherited parent PID would tie the bridge to whoever ran this script.
    delete env.ORKESTRATOR_PARENT_PID;
    let entry: string;
    if (kind === "codex") {
      const codexHome = join(home, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      copyFileSync(deps.credentialPath, join(codexHome, "auth.json"));
      chmodSync(join(codexHome, "auth.json"), 0o600);
      Object.assign(env, {
        CODEX_PATH: options.codex,
        CODEX_HOME: codexHome,
        CODEX_BRIDGE_TOKEN: token,
      });
      entry = "bridges/codex-bridge/src/index.ts";
    } else {
      const userHome = join(home, "user-home");
      mkdirSync(join(userHome, ".claude"), { recursive: true });
      Object.assign(env, {
        HOME: userHome,
        CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
        CLAUDE_BRIDGE_TOKEN: token,
      });
      entry = "bridges/claude-bridge/src/index.ts";
    }
    const child = deps.spawn("bun", [join(options.root, entry)], {
      cwd: workspace,
      env,
      stdio: "ignore",
      detached: true,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    let startupError: Error | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error) => {
        startupError = error;
        resolve();
      });
    });
    bridge = { kind, child, baseUrl, token, home, exited };
    for (let attempt = 0; attempt < deps.readinessAttempts; attempt += 1) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await deps.fetch(`${baseUrl}/session/list`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.status === 200) return bridge;
      } catch {
        // Not listening yet.
      }
      await delay(deps.pollMs);
    }
    throw startupError ?? new Error(`${kind} bridge did not start`);
  } catch (error) {
    try {
      if (bridge) await stopBridge(bridge, deps.stopBudgetMs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Stop only the process group we started, then reap the child before deleting its home. */
export async function stopBridge(bridge: RunningBridge, budgetMs = 500): Promise<void> {
  const signal = (value: NodeJS.Signals) => {
    try {
      if (bridge.child.pid) process.kill(-bridge.child.pid, value);
    } catch {
      // Already gone (including a failed spawn with no PID).
    }
  };
  const waitForExit = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bridge.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  signal("SIGTERM");
  await waitForExit();
  // The bridge may have exited while its descendants still own the group.
  signal("SIGKILL");
  await waitForExit();
}
