/**
 * Withholding the GitHub credential from a Codex thread (graphs item 209).
 *
 * The shared app-server keeps the credential in its own environment; a thread
 * whose policy denies `github.write` gets a `shell_environment_policy` that
 * keeps it out of every command the thread runs. The real binary's behaviour
 * is pinned by `app-server/live-github-credential.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import {
  codexGitHubCredentialThreadConfig,
  codexProcessShellExclude,
} from "../github-credential-config.js";
import { promptThreadConfig } from "../prompt-thread-config.js";
import { BUILD, harness, thread } from "./app-server-engine-test-harness.js";
import type { EngineTurnConfig } from "./types.js";

function policy(
  capabilityPolicy: NativeAgentExecutionPolicy["capabilityPolicy"],
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    // On, so the thread needs no skills/list round trip.
    projectResources: true,
    networkAccess: "full",
    capabilityPolicy,
  };
}

const GRAPH = policy({ deny: ["file.write"], extendedDeny: ["github.write"] });
const ORDINARY = policy({ deny: [] });

const RESETS = {
  GH_CONFIG_DIR: "/tmp/empty-gh",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "credential.https://gist.github.com.helper",
  GIT_CONFIG_VALUE_2: "",
};

describe("codexGitHubCredentialThreadConfig", () => {
  test("a graph policy excludes every credential variable and sets the replacements", () => {
    expect(codexGitHubCredentialThreadConfig(GRAPH, { ghConfigDir: "/tmp/empty-gh" })).toEqual({
      "shell_environment_policy.exclude": [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ORKESTRATOR_GITHUB_CREDENTIAL_FILE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_*",
        "GIT_CONFIG_VALUE_*",
      ],
      "shell_environment_policy.set": RESETS,
    });
  });

  test("a policy that allows GitHub writes changes nothing", () => {
    expect(codexGitHubCredentialThreadConfig(ORDINARY, { ghConfigDir: "/tmp/x" })).toEqual({});
    expect(codexGitHubCredentialThreadConfig(undefined, { ghConfigDir: "/tmp/x" })).toEqual({});
  });

  test("a coordinator process's own excludes are repeated, because the thread value replaces them", () => {
    const processExclude = codexProcessShellExclude(
      codexAppServerConfigOverrides({
        ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
        CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-profile",
        CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/tmp/runtime",
        CWD: "/tmp/workspace",
      }),
    );
    expect(processExclude).toContain("*_TOKEN");
    expect(processExclude).toContain("ORKESTRATOR_AGENT_MCP_TOKEN");
    const config = codexGitHubCredentialThreadConfig(GRAPH, {
      ghConfigDir: "/tmp/empty-gh",
      processExclude,
    });
    const exclude = config["shell_environment_policy.exclude"] as string[];
    expect(exclude.slice(0, processExclude.length)).toEqual(processExclude);
    expect(exclude).toContain("GH_TOKEN");
    expect(new Set(exclude).size).toBe(exclude.length);
    // `inherit` and `ignore_default_excludes` are left to the process.
    expect(Object.keys(config).sort()).toEqual([
      "shell_environment_policy.exclude",
      "shell_environment_policy.set",
    ]);
  });

  test("reads the process exclude list defensively", () => {
    expect(codexProcessShellExclude(undefined)).toEqual([]);
    expect(codexProcessShellExclude(codexAppServerConfigOverrides({}))).toEqual([]);
    expect(
      codexProcessShellExclude({ "shell_environment_policy.exclude": '["A", 1, "B"]' }),
    ).toEqual(["A", "B"]);
    expect(codexProcessShellExclude({ "shell_environment_policy.exclude": "not json" })).toEqual(
      [],
    );
  });

  test("a change in withholding forces a thread reload", () => {
    expect(promptThreadConfig({ ...BUILD, policy: GRAPH })).not.toBe(
      promptThreadConfig({ ...BUILD, policy: ORDINARY }),
    );
  });
});

describe("withholding on the engine", () => {
  const config: EngineTurnConfig = { ...BUILD, policy: GRAPH };

  test("start, resume and fork carry the command environment policy", async () => {
    let dirs = 0;
    const h = harness(
      {
        "thread/start": () => ({ thread: thread("t1") }),
        "thread/resume": () => ({ thread: thread("t1") }),
        "thread/fork": () => ({ thread: thread("t2") }),
      },
      {
        ghConfigDir: async () => {
          dirs += 1;
          return "/tmp/empty-gh";
        },
      },
    );
    try {
      await h.engine.start();
      await h.engine.startThread({ config });
      await h.engine.resumeThread("t1", { config, includeTurns: true });
      await h.engine.forkThread("t1", config);
      for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
        const params = h.child().requests.find((request) => request.method === method)?.params;
        const threadConfig = (params?.config ?? {}) as Record<string, unknown>;
        expect(threadConfig).toMatchObject({ "shell_environment_policy.set": RESETS });
        expect(threadConfig["shell_environment_policy.exclude"]).toContain("GITHUB_TOKEN");
      }
      expect(dirs).toBe(3);
    } finally {
      await h.engine.stop();
    }
  });

  test("an ordinary session's threads carry no command environment policy", async () => {
    const h = harness(
      { "thread/start": () => ({ thread: thread("t1") }) },
      {
        ghConfigDir: async () => {
          throw new Error("not needed");
        },
      },
    );
    try {
      await h.engine.start();
      await h.engine.startThread({ config: { ...BUILD, policy: ORDINARY } });
      const params = h.child().requests.find((request) => request.method === "thread/start")
        ?.params as { config?: Record<string, unknown> } | undefined;
      expect(
        Object.keys(params?.config ?? {}).filter((key) =>
          key.startsWith("shell_environment_policy"),
        ),
      ).toEqual([]);
    } finally {
      await h.engine.stop();
    }
  });

  test("a gh directory that cannot be created refuses the thread", async () => {
    const h = harness(
      { "thread/start": () => ({ thread: thread("t1") }) },
      {
        ghConfigDir: async () => {
          throw new Error("no temporary directory");
        },
      },
    );
    try {
      await h.engine.start();
      await expect(h.engine.startThread({ config })).rejects.toThrow("no temporary directory");
      expect(h.child().requests.some((request) => request.method === "thread/start")).toBe(false);
    } finally {
      await h.engine.stop();
    }
  });
});
