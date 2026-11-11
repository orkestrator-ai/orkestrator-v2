/**
 * No backend command hands a stored secret to its caller.
 *
 * Every client that can reach the command bridge (a tailnet browser, a remote
 * desktop, a federated command node, a short-lived workspace grant) can call
 * any registered command, and there is no response-redaction layer behind
 * them. So this calls every one of them, three times each with different
 * arguments, against a data directory whose stored credentials are canaries,
 * with canaries also in the inherited environment and in the agents' own
 * credential files, and fails on any answer, error or emitted event that
 * carries one. It is the guard for finding M3 in
 * `docs/reports/2-26-10-27-security.md`.
 *
 * The calls run in a child process (`commands-secret-sweep-test-support.ts`)
 * with a constructed environment: temporary HOME and XDG directories, a PATH
 * holding no programs, no inherited `ORKESTRATOR_*` variable and no network.
 * A command that reaches for Docker, Git or an agent CLI finds nothing, and
 * any background work it starts dies with the child.
 *
 * A command may legitimately reject the arguments it gets; only what reaches
 * the caller is checked. A command that is meant to return a credential (none
 * today) needs its own allowlist entry here with the reason.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_SECRET_CANARIES } from "../../../../tests/helpers/auth-secret-canaries.js";
import { createCommandRegistry } from "./commands.js";
import {
  settleWithin,
  type SweepRecord,
  type SweepVariant,
} from "./commands-secret-sweep-test-support.js";

jest.setTimeout(120_000);

const MARK = "ORKCANARY";
const SWEEP_SCRIPT = path.join(import.meta.dir, "commands-secret-sweep-test-support.ts");
const SWEEP_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const VARIANTS: SweepVariant[] = ["empty", "seeded", "shaped"];

/** Credentials a backend inherits from its environment, each a canary. */
const ENVIRONMENT_CANARIES: Record<string, string> = {
  ANTHROPIC_API_KEY: AUTH_SECRET_CANARIES.anthropicApiKey,
  CLAUDE_CODE_OAUTH_TOKEN: AUTH_SECRET_CANARIES.claudeOAuthToken,
  OPENAI_API_KEY: AUTH_SECRET_CANARIES.openAiApiKey,
  CODEX_API_KEY: AUTH_SECRET_CANARIES.openAiApiKey,
  CURSOR_API_KEY: AUTH_SECRET_CANARIES.cursorApiKey,
  XAI_API_KEY: AUTH_SECRET_CANARIES.xaiApiKey,
  GH_TOKEN: AUTH_SECRET_CANARIES.githubToken,
  GITHUB_TOKEN: AUTH_SECRET_CANARIES.githubToken,
  OPENCODE_GO_API_KEY: AUTH_SECRET_CANARIES.openCodeZenApiKey,
};

/** The agents' own sign-in files under the sweep's HOME, holding canaries. */
async function plantCredentialFiles(home: string): Promise<void> {
  const write = async (relative: string, contents: string) => {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode: 0o600 });
  };
  await write(
    ".claude/.credentials.json",
    JSON.stringify({
      claudeAiOauth: {
        accessToken: AUTH_SECRET_CANARIES.claudeOAuthToken,
        refreshToken: AUTH_SECRET_CANARIES.refreshToken,
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  await write(
    ".claude.json",
    JSON.stringify({ primaryApiKey: AUTH_SECRET_CANARIES.anthropicApiKey }),
  );
  await write(
    ".codex/auth.json",
    JSON.stringify({
      OPENAI_API_KEY: AUTH_SECRET_CANARIES.openAiApiKey,
      tokens: {
        access_token: AUTH_SECRET_CANARIES.accessToken,
        refresh_token: AUTH_SECRET_CANARIES.refreshToken,
        id_token: AUTH_SECRET_CANARIES.idToken,
      },
    }),
  );
  await write(
    ".config/gh/hosts.yml",
    `github.com:\n  oauth_token: ${AUTH_SECRET_CANARIES.githubToken}\n  user: sweep\n`,
  );
  await write(
    ".pi/agent/auth.json",
    JSON.stringify({ anthropic: { type: "api_key", key: AUTH_SECRET_CANARIES.anthropicApiKey } }),
  );
}

type SweepRun = { records: SweepRecord[]; output: string; exitCode: number | null };

async function runSweep(root: string): Promise<SweepRun> {
  const home = path.join(root, "home");
  const emptyBin = path.join(root, "bin");
  const tmp = path.join(root, "tmp");
  const sweepRoot = path.join(root, "sweep");
  await Promise.all(
    [home, emptyBin, tmp, sweepRoot].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  await plantCredentialFiles(home);
  const resultFile = path.join(root, "result.json");

  // Built from nothing rather than filtered from process.env: the test may be
  // running under a production backend whose own variables must not leak in.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: tmp,
    PATH: emptyBin,
    NODE_ENV: "test",
    LANG: "C.UTF-8",
    ...ENVIRONMENT_CANARIES,
  };

  const child = spawn(process.execPath, ["--no-env-file", SWEEP_SCRIPT, sweepRoot, resultFile], {
    // Not the repository: bun reads bunfig.toml and .env from its cwd.
    cwd: root,
    env,
    // Its own process group, so anything a command spawned can be stopped with it.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const collect = (chunk: Buffer) => {
    if (outputBytes >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk);
    outputBytes += chunk.length;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`secret sweep did not finish within ${SWEEP_TIMEOUT_MS}ms`));
    }, SWEEP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  }).finally(() => {
    // The group was created detached above, so it holds only the sweep and
    // whatever it started.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const output = Buffer.concat(chunks).toString("utf8");
  const records =
    exitCode === 0 ? (JSON.parse(await fs.readFile(resultFile, "utf8")) as SweepRecord[]) : [];
  return { records, output, exitCode };
}

describe("every registered command, with canary secrets planted", () => {
  let root: string;
  let run: SweepRun;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-secret-sweep-"));
    run = await runSweep(root);
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  test("the sweep completes", () => {
    // The output can only hold canaries if a later test fails on it, so it is
    // reported by length rather than printed.
    expect(run.exitCode, `sweep output was ${run.output.length} characters`).toBe(0);
  });

  test("calls every registered command with each argument variant", () => {
    const registered = Array.from(createCommandRegistry().keys()).sort();
    for (const variant of VARIANTS) {
      const swept = run.records
        .filter((record) => record.variant === variant)
        .map((record) => record.command)
        .sort();
      expect(swept).toEqual(registered);
    }
  });

  test("no answer, error or emitted event carries a planted secret", () => {
    const leaks = run.records
      .filter((record) => record.leaks.length > 0)
      .map((record) => `${record.command} (${record.variant}): ${record.leaks.join(", ")}`);
    expect(leaks).toEqual([]);
  });

  test("nothing the commands logged carries a planted secret", () => {
    expect(run.output.includes(MARK)).toBe(false);
  });

  test("reaches the commands that read and write the stored config", () => {
    // Proof the sweep is not vacuous: these return config-derived state when
    // they succeed, so each must actually answer in at least one variant.
    const answered = new Set(
      run.records.filter((record) => record.outcome === "resolved").map((record) => record.command),
    );
    for (const command of [
      "get_config",
      "update_global_config",
      "patch_global_config",
      "patch_repository_settings",
      "update_repository_config",
      "update_notification_sound_settings",
      "set_container_resource_limits",
      "update_worktree_locations",
      "get_agent_messaging_settings",
      "update_agent_messaging_settings",
    ]) {
      expect(answered.has(command), `${command} never answered`).toBe(true);
    }
    // A broken sweep context would make nearly everything reject.
    expect(answered.size).toBeGreaterThan(150);
  });
});

// The sweep must fail even if the eventual secret-bearing response arrives
// after the inspection deadline. Late rejections must remain handled too.
for (const outcome of ["resolved", "rejected"] as const) {
  test(`an uninspected delayed ${outcome} canary fails the sweep`, async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      finish = outcome === "resolved" ? resolve : reject;
    });
    await expect(settleWithin(() => response, 1)).rejects.toThrow("response uninspected");
    finish(
      outcome === "resolved"
        ? AUTH_SECRET_CANARIES.githubToken
        : new Error(AUTH_SECRET_CANARIES.githubToken),
    );
    await Promise.resolve();
  });
}
