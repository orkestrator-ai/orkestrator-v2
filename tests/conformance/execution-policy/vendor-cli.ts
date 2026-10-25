/** Hermetic, offline qualification against the repository's pinned vendor CLIs. */
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest.js";

export function policyQualificationCli(agent: "claude" | "grok" | "opencode"): string | undefined {
  const explicit = process.env[`ORKESTRATOR_POLICY_${agent.toUpperCase()}_PATH`];
  if (explicit) {
    if (!existsSync(explicit))
      throw new Error(`Policy qualification ${agent} executable is missing`);
    return explicit;
  }
  const data =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "orkestrator-v2")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "orkestrator-v2");
  const binary = join(
    data,
    "toolchains",
    agent,
    PINNED_TOOLCHAIN_VERSIONS[agent],
    `${process.platform}-${process.arch}`,
    agent,
  );
  return existsSync(binary) ? binary : undefined;
}

export async function withPolicyCliFixture<T>(
  run: (fixture: { root: string; cwd: string; env: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "policy-cli-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd), mkdir(home)]);
  try {
    return await run({
      root,
      cwd,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function policyCliOutput(
  executable: string,
  args: string[],
  fixture: {
    cwd: string;
    env: Record<string, string>;
  },
): Promise<string> {
  const child = Bun.spawn([executable, ...args], { ...fixture, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    // Stream caps prevent an upstream regression from retaining unbounded output.
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      let text = "";
      for await (const bytes of stream) {
        text += new TextDecoder().decode(bytes);
        if (text.length > 512 * 1024) {
          child.kill();
          throw new Error("Policy CLI output exceeded its bound");
        }
      }
      return text;
    };
    const [stdout, , status] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    if (status !== 0) throw new Error(`Policy CLI qualification exited ${status}`);
    return stdout;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}
