import { expect } from "./electron-fixtures";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

type Project = { id: string; name: string };
type Environment = { id: string; name: string; status?: string; worktreePath?: string | null };

/** Nothing of the host's identity, and no probe that adds a Docker network. */
function leafEnvironment(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    GH_CONFIG_DIR: path.join(dir, "github-disabled"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    CODEX_HOME: path.join(dir, "codex"),
    PI_CODING_AGENT_DIR: path.join(dir, "pi"),
    ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  };
  delete env.NODE_ENV;
  return env;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  expect(result.status, `${command} ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

/** Names for a leaf; the defaults are the single leaf `relayed-events-electron.spec.ts` attaches. */
export interface LeafNames {
  /** The leaf's display name (default `Leaf`), and its directory under `root` in lower case. */
  readonly name?: string;
  /** Its one environment's name (default `leaf-env`). */
  readonly environmentName?: string;
}

/** A standalone backend from source: the leaf the desktop's command node attaches. */
export async function startLeaf(root: string, names: LeafNames = {}) {
  const name = names.name ?? "Leaf";
  const [port] = (await reserveLoopbackPorts(1)) as [number];
  const token = randomBytes(24).toString("base64url");
  const dir = path.join(root, name.toLowerCase());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const env = leafEnvironment(dir);
  const child = spawn(
    "bun",
    [
      "apps/backend/src/main.ts",
      "--data-dir",
      path.join(dir, "data"),
      "--host",
      "127.0.0.1",
      "--allow-non-tailscale-bind",
      "--port",
      String(port),
      "--strict-gateway-port",
      "--runtime-flavor",
      "agent-test",
      "--worktree-dir",
      path.join(dir, "worktrees"),
    ],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...env,
        ORKESTRATOR_GATEWAY_TOKEN: token,
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the leaf did not start")), 90_000);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('"orkestrator-backend-ready"')) {
        clearTimeout(timer);
        child.stdout?.resume();
        resolve();
      }
      buffer = buffer.slice(-4096);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the leaf exited early (${code})`));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`${origin}/__orkestrator/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    const payload = (await response.json()) as { result?: T; error?: string };
    if (!response.ok) throw new Error(`leaf ${command}: ${payload.error ?? response.status}`);
    return payload.result as T;
  };
  // One project with one local environment, named so its rows are easy to find.
  const repo = path.join(dir, "repos", "leaf-app");
  const bare = path.join(dir, "repos", "leaf-app.git");
  await mkdir(repo, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], repo, env);
  run(
    "git",
    [
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    repo,
    env,
  );
  run("git", ["init", "-q", "--bare", "-b", "main", bare], dir, env);
  run("git", ["remote", "add", "origin", bare], repo, env);
  run("git", ["push", "-q", "-u", "origin", "main"], repo, env);
  const project = await invoke<Project>("add_project", { gitUrl: bare, localPath: repo });
  const environment = await invoke<Environment>("create_environment", {
    projectId: project.id,
    name: names.environmentName ?? "leaf-env",
    environmentType: "local",
  });
  const profile = await invoke<{ revision: number }>("get_backend_profile");
  await invoke("update_backend_profile", {
    expectedRevision: profile.revision,
    displayName: name,
    colorToken: "blue",
  });
  const { nodeId } = await invoke<{ nodeId: string }>("get_node_status");
  return { child, origin, token, invoke, nodeId, project, environment };
}
