// Runs outside the session harness's SDK mock, using only control requests,
// temporary settings and a fake API key. No prompt or model request is sent.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { controlOnlyQuery } from "./control-only-query.js";
import { createSession, sessions } from "./session-manager-core.js";
import { getAvailableModelCatalog } from "./session-manager-interactions.js";
import { readClaudeAuthStatus, resetClaudeSignInForTesting } from "./claude-sign-in.js";
import { liveInitializationResult } from "./live-claude-control.js";

const open = new Set<Query>();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    for (const control of open) control.close();
    process.exit(1);
  });
}

const root = await mkdtemp(join(tmpdir(), "claude-live-control-"));
const cwd = join(root, "project");
const home = join(root, "home");
const config = join(home, ".claude");
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_API_KEY: "sk-ant-test-live-control-fixture",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

// The bridge's fallback probes use process.env; isolate those too.
const originalEnv = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env, { CWD: cwd });

function launch(settingSources?: SettingSource[]): Query {
  const control = controlOnlyQuery({ cwd, env, ...(settingSources ? { settingSources } : {}) });
  open.add(control);
  return control;
}

function register(control: Query, settingSources: SettingSource[]) {
  const session = createSession("SDK initialization contract");
  // Only the fields the metadata reader needs: no model loop or idle timer.
  session.claudeRuntime = {
    state: "open",
    control,
    abortController: new AbortController(),
    launch: { settingSources: JSON.stringify(settingSources) },
    lastFrameAt: Date.now(),
  } as unknown as NonNullable<typeof session.claudeRuntime>;
  return session;
}

try {
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  await writeFile(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ availableModels: ["haiku"] }),
  );

  const unrestricted = launch(["user", "project"]);
  const unrestrictedModels = await unrestricted.supportedModels();
  const session = register(unrestricted, ["user", "project"]);
  const probe = launch();
  const restrictedModels = await probe.supportedModels();
  const skippedCatalog = await getAvailableModelCatalog();

  const sources: SettingSource[] = ["user", "project", "local"];
  const matching = launch(sources);
  sessions.delete(session.id);
  register(matching, sources);
  const initialization = await liveInitializationResult(matching);
  const sdkAccount = await matching.accountInfo();
  const sdkModels = await matching.supportedModels();
  let initializationReads = 0;
  const initialize = matching.initializationResult.bind(matching);
  matching.initializationResult = () => {
    initializationReads += 1;
    return initialize();
  };
  const liveCatalog = await getAvailableModelCatalog();
  resetClaudeSignInForTesting();
  const liveAccount = await readClaudeAuthStatus();

  // Assert with the real SDK response before serializing only safe evidence.
  const { expect } = await import("bun:test");
  expect(unrestrictedModels.length).toBeGreaterThan(restrictedModels.length);
  expect(restrictedModels.length).toBeGreaterThan(0);
  expect(restrictedModels.some((model) => model.value.includes("haiku"))).toBe(true);
  expect(skippedCatalog.models.map((model) => model.id)).toEqual(
    restrictedModels.map((model) => model.value),
  );
  expect(initialization?.models).toEqual(sdkModels);
  expect(initialization?.account).toEqual(sdkAccount);
  expect(liveCatalog.source).toBe("sdk");
  expect(liveCatalog.models.map((model) => model.id)).toEqual(
    sdkModels.map((model) => model.value),
  );
  expect(liveAccount.state).toBe("signed-in");
  expect(initializationReads).toBe(2);
  console.log("__LIVE_CONTROL_VERIFIED__");
} finally {
  sessions.clear();
  for (const control of open) control.close();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(root, { recursive: true, force: true });
}
