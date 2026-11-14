import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAccountsRuntime } from "../agent-accounts-runtime.js";
import {
  AGENT_TEST_ANTHROPIC_ORIGIN_ENV,
  AGENT_TEST_USAGE_ORIGIN_ENV,
  agentTestAnthropicOrigin,
  agentTestUsageOrigin,
  applyAgentTestAnthropicOrigin,
} from "../agent-test-fixtures.js";
import type { CommandContext } from "../commands-context.js";
import { defaultDataDir } from "../../data-dir.js";
import {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  createPlanUsageReader,
  planUsageUrl,
  readAgentAccountPlanUsage,
} from "./reader.js";

/**
 * To-do 7542 task 1: an isolated agent-test profile's backend reads Claude
 * and Codex plan usage from a loopback server, and points its Claude bridges
 * at a loopback model, and nothing else ever does.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function profileDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-usage-origin-"));
  directories.push(directory);
  return directory;
}

const ORIGIN = "http://127.0.0.1:43123";

/** An isolated agent-test environment; `null` sets no usage origin. */
function isolatedEnv(origin: string | null = ORIGIN): NodeJS.ProcessEnv {
  return {
    ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
    ...(origin === null ? {} : { [AGENT_TEST_USAGE_ORIGIN_ENV]: origin }),
  };
}

function context(
  dataDir: string,
  runtimeFlavor: CommandContext["runtimeFlavor"] = "agent-test",
): CommandContext {
  return {
    runtimeFlavor,
    storage: {
      loadConfig: async () => ({ global: {} }),
      getDataDir: () => dataDir,
      agentAccounts: { load: async () => ({ version: 1, accounts: [], active: {} }) },
    },
    runtime: { accounts: new AgentAccountsRuntime() },
  } as unknown as CommandContext;
}

describe("agentTestUsageOrigin", () => {
  test("answers the origin in an isolated agent-test profile", async () => {
    const dataDir = await profileDir();
    expect(
      agentTestUsageOrigin({
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: isolatedEnv(),
      }),
    ).toBe(ORIGIN);
    expect(
      agentTestUsageOrigin({
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: isolatedEnv("http://localhost:9/"),
      }),
    ).toBe("http://localhost:9");
  });

  test("is refused outside an isolated agent-test profile", async () => {
    const dataDir = await profileDir();
    for (const runtimeFlavor of ["production", "development", undefined]) {
      expect(
        agentTestUsageOrigin({ runtimeFlavor, dataDir: () => dataDir, env: isolatedEnv() }),
      ).toBeUndefined();
    }
    expect(
      agentTestUsageOrigin({
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: { [AGENT_TEST_USAGE_ORIGIN_ENV]: ORIGIN },
      }),
    ).toBeUndefined();
    // The default data directory is the user's own, whatever the flavor says.
    // The gate resolves "default" from the env it is given, so the expected
    // directory comes from that same env (on Linux, `XDG_CONFIG_HOME` moves it).
    for (const env of [isolatedEnv(), { ...isolatedEnv(), XDG_CONFIG_HOME: dataDir }]) {
      expect(
        agentTestUsageOrigin({
          runtimeFlavor: "agent-test",
          dataDir: () => defaultDataDir(process.platform, env),
          env,
        }),
      ).toBeUndefined();
    }
  });

  test("accepts only a bare loopback origin", async () => {
    const dataDir = await profileDir();
    for (const origin of [
      "",
      "not a url",
      "http://example.com",
      "http://10.0.0.5:4000",
      "http://127.0.0.1.example.com",
      "file:///tmp/usage",
      "http://user:pass@127.0.0.1:4000",
      "http://127.0.0.1:4000/elsewhere",
      "http://127.0.0.1:4000/?x=1",
      "http://127.0.0.1:4000/#x",
    ]) {
      expect(
        agentTestUsageOrigin({
          runtimeFlavor: "agent-test",
          dataDir: () => dataDir,
          env: isolatedEnv(origin),
        }),
      ).toBeUndefined();
    }
  });
});

describe("agentTestAnthropicOrigin", () => {
  const anthropicEnv = (origin: string): NodeJS.ProcessEnv => ({
    ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
    [AGENT_TEST_ANTHROPIC_ORIGIN_ENV]: origin,
  });

  test("points a Claude bridge at the loopback model in an isolated agent-test profile", async () => {
    const dataDir = await profileDir();
    const bridgeEnv: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
    expect(
      applyAgentTestAnthropicOrigin(bridgeEnv, {
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: anthropicEnv(ORIGIN),
      }),
    ).toBe(true);
    expect(bridgeEnv).toEqual({
      ANTHROPIC_BASE_URL: ORIGIN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    // The usage origin is a different variable; neither stands in for the other.
    expect(
      agentTestAnthropicOrigin({
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: isolatedEnv(),
      }),
    ).toBeUndefined();
  });

  test("leaves a bridge alone everywhere else", async () => {
    const dataDir = await profileDir();
    const refused: Array<Parameters<typeof applyAgentTestAnthropicOrigin>[1]> = [
      { runtimeFlavor: "production", dataDir: () => dataDir, env: anthropicEnv(ORIGIN) },
      { runtimeFlavor: "development", dataDir: () => dataDir, env: anthropicEnv(ORIGIN) },
      {
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: { [AGENT_TEST_ANTHROPIC_ORIGIN_ENV]: ORIGIN },
      },
      ...[anthropicEnv(ORIGIN), { ...anthropicEnv(ORIGIN), XDG_CONFIG_HOME: dataDir }].map(
        (env) => ({
          runtimeFlavor: "agent-test",
          // The same env the gate reads decides where the default directory is.
          dataDir: () => defaultDataDir(process.platform, env),
          env,
        }),
      ),
      {
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: anthropicEnv("https://api.anthropic.com"),
      },
      {
        runtimeFlavor: "agent-test",
        dataDir: () => dataDir,
        env: anthropicEnv("http://127.0.0.1:4000/v1"),
      },
    ];
    for (const options of refused) {
      const bridgeEnv: NodeJS.ProcessEnv = {};
      expect(applyAgentTestAnthropicOrigin(bridgeEnv, options)).toBe(false);
      expect(bridgeEnv).toEqual({});
    }
  });
});

describe("plan usage reads in an agent-test profile", () => {
  test("keep the provider's path on the loopback origin", async () => {
    const dataDir = await profileDir();
    expect(planUsageUrl(context(dataDir), "claude", isolatedEnv())).toBe(
      `${ORIGIN}/api/oauth/usage`,
    );
    expect(planUsageUrl(context(dataDir), "codex", isolatedEnv())).toBe(
      `${ORIGIN}/backend-api/codex/usage`,
    );
  });

  test("a production backend reads the real endpoints even with the variables set", async () => {
    const dataDir = await profileDir();
    expect(planUsageUrl(context(dataDir, "production"), "claude", isolatedEnv())).toBe(
      CLAUDE_USAGE_URL,
    );
    expect(planUsageUrl(context(dataDir, "production"), "codex", isolatedEnv())).toBe(
      CODEX_USAGE_URL,
    );
    expect(planUsageUrl(context(dataDir), "claude", isolatedEnv(null))).toBe(CLAUDE_USAGE_URL);
  });

  test("the settings reader and the per-account read both go to the loopback server", async () => {
    const dataDir = await profileDir();
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ five_hour: { utilization: 40 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({
      fetchImpl,
      env: isolatedEnv(),
      credentials: { claude: async () => "fixture-token" },
    });
    expect((await reader(context(dataDir), "claude")).status).toBe("ok");
    const { snapshot } = await readAgentAccountPlanUsage(
      context(dataDir),
      "claude",
      "fixture-token",
      { fetchImpl, env: isolatedEnv() },
    );
    expect(snapshot.status).toBe("ok");
    expect(seen).toEqual([
      `${ORIGIN}/api/oauth/usage?cedar_ember=1`,
      `${ORIGIN}/api/oauth/usage?cedar_ember=1`,
    ]);
  });
});
