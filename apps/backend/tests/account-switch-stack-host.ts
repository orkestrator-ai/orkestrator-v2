/**
 * Runs one `account-switch-stack` scenario in this process and prints its
 * evidence as one marked line of stdout. `account-switch-resend-live.test.ts` starts
 * it with a throwaway HOME and asserts on the evidence.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { USAGE_LIMIT_RESEND_MARKER } from "@orkestrator/protocol/agent-account-auto-switch";

import {
  fixtureToken,
  installScriptedUsage,
  STACK_EVIDENCE_PREFIX,
  STACK_ACCOUNT_NAMES,
  stackPathsFromEnvironment,
  startScriptedProvider,
  writeFixtureLogin,
  type ModelCall,
  type StackAccountName,
  type StackEvidence,
  type StackPlatform,
  type StackProvider,
  type StackScenario,
} from "./account-switch-stack";

const [platform, scenario] = process.argv.slice(2) as [StackPlatform, StackScenario];
const paths = stackPathsFromEnvironment();
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const ORIGINAL = `ORIGINAL-${randomUUID()}`;
const modelFields = { model: platform === "claude" ? "sonnet" : "gpt-5.5" };

const tokens = new Map<string, StackAccountName>(
  STACK_ACCOUNT_NAMES.map((name) => [fixtureToken(platform, name), name]),
);
const provider: StackProvider = {
  calls: [],
  behavior: {
    soonest: "refuse",
    later: scenario === "native-all-out" ? "refuse" : "reply",
  },
  readings: { soonest: { weeklyUsedPercent: 50 }, later: { weeklyUsedPercent: 10 } },
  refusalClaim: scenario === "native-other-limit" ? "five_hour" : "seven_day",
  // A real weekly refusal reads 100%; a 5-hour one leaves the week where it was.
  onRefusal: (account) => {
    provider.firstRefusalAt ??= Date.now();
    if (scenario === "native-other-limit") provider.readings[account].fiveHourUsedPercent = 100;
    else provider.readings[account].weeklyUsedPercent = 100;
  },
  usageReads: [],
};

// Before the backend exists: its usage reader captures `fetch` when it is built.
installScriptedUsage(tokens, provider);
// A workflow writes its own prompts, so every one of its calls is the work under test.
const nativeScenario = scenario.startsWith("native-");
const endpoint = startScriptedProvider(
  platform,
  tokens,
  provider,
  (texts) => !nativeScenario || texts.some((text) => text.includes(ORIGINAL)),
);
if (platform === "claude") {
  process.env.ANTHROPIC_BASE_URL = endpoint.origin;
} else {
  // Accounts link this file from the host login's directory.
  mkdirSync(path.join(paths.home, ".codex"), { recursive: true });
  writeFileSync(
    path.join(paths.home, ".codex", "config.toml"),
    [
      `openai_base_url = "${endpoint.origin}/v1"`,
      `chatgpt_base_url = "${endpoint.origin}/backend-api"`,
      "check_for_update_on_startup = false",
      "",
    ].join("\n"),
  );
}

const { OrkestratorBackend } = await import("../src/core/index");
const { createEnvironment, createProject } = await import("../src/core/storage");
const backend = new OrkestratorBackend({
  dataDir: paths.dataDir,
  toolchainBinDir: paths.toolchainBin,
  appRoot: repositoryRoot,
  resourceRoot: repositoryRoot,
  worktreeDir: path.join(paths.root, "worktrees"),
  // No host login is granted, so nothing here can reach the real one.
  runtimeFlavor: "agent-test",
  credentialSources: [],
  emit: () => undefined,
});
await backend.init();
const context = backend["context"];
const storage = context.storage;

function git(...args: string[]): void {
  execFileSync("git", ["-C", paths.worktree, ...args], { stdio: "ignore" });
}
execFileSync("git", ["init", "-q", "-b", "main", paths.worktree]);
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.com");
writeFileSync(path.join(paths.worktree, "README.md"), "fixture\n");
git("add", ".");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "feature");
writeFileSync(path.join(paths.worktree, "README.md"), "fixture change\n");
git("commit", "-q", "-am", "change");

const project = await storage.addProject(createProject("fixture", paths.worktree));
const environment = {
  ...createEnvironment(project.id, { environmentType: "local", name: "fixture" }),
  branch: "feature",
  worktreePath: paths.worktree,
  status: "running" as const,
  setupPhase: "ready" as const,
};
await storage.addEnvironment(environment);
const bridgeKey = `${platform}:${environment.id}`;

const accountIds = Object.fromEntries(
  STACK_ACCOUNT_NAMES.map((name) => [name, randomUUID()]),
) as Record<StackAccountName, string>;
const accountsRoot = storage.agentAccounts.agentAccountsDirectory();
const accountHome = (name: StackAccountName) => path.join(accountsRoot, platform, accountIds[name]);
const credentialFile = platform === "claude" ? ".credentials.json" : "auth.json";
const logins = {} as Record<StackAccountName, string>;
for (const name of STACK_ACCOUNT_NAMES) {
  writeFixtureLogin(platform, accountHome(name), name);
  logins[name] = readFileSync(path.join(accountHome(name), credentialFile), "utf8");
}
await storage.agentAccounts.mutateAgentAccounts((store) => ({
  store: {
    ...store,
    accounts: STACK_ACCOUNT_NAMES.map((name) => ({
      id: accountIds[name],
      platform,
      label: name,
      createdAt: new Date(0).toISOString(),
      identity: { email: `${name}@example.com` },
    })),
    active: { [platform]: accountIds.soonest },
  },
  result: undefined,
}));
await backend.invoke("set_agent_account_auto_switch", { platform, enabled: true });
for (const name of STACK_ACCOUNT_NAMES) {
  await backend.invoke("set_agent_account_auto_switch", {
    platform,
    email: `${name}@example.com`,
    included: true,
  });
}

/** Each bridge process that served this environment, in order. */
const bridgePids: number[] = [];
const noteBridge = () => {
  const pid = context.runtime.localServers.process(bridgeKey)?.pid;
  if (pid && bridgePids.at(-1) !== pid) bridgePids.push(pid);
};
const bridgeWatch = setInterval(noteBridge, 100);

async function until(condition: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(summary())}`);
    }
    await Bun.sleep(100);
  }
}

/** A native resend carries the marker; a workflow's continuation says it in its own words. */
const WORKFLOW_RESEND_WORDS = "weekly usage limit ran out, and this session has moved";
const isResendTurn = (call: ModelCall) => {
  const prompt = call.userTexts.at(-1) ?? "";
  return prompt.includes(USAGE_LIMIT_RESEND_MARKER) || prompt.includes(WORKFLOW_RESEND_WORDS);
};

/** The prompt each refused call was carrying, as its last user message. */
const refusedPrompts = () =>
  provider.calls.flatMap((call) => (call.refused && call.userTexts.at(-1)) || []);

function summary(): StackEvidence["calls"] {
  return provider.calls.map((call) => ({
    account: call.account,
    refused: call.refused,
    resendTurn: isResendTurn(call),
    // How many times the stopped prompts appear in what this call sent: one from
    // the transcript is a continuation, none lost the conversation, two ran it twice.
    stoppedPromptCopies: Math.max(
      0,
      ...refusedPrompts().map((prompt) => call.userTexts.filter((text) => text === prompt).length),
    ),
    plan: call.userTexts.at(-1)?.includes("You are in Orkestrator plan mode") === true,
  }));
}

const refusals = () => provider.calls.filter((call) => call.refused).length;
const resends = () => provider.calls.filter(isResendTurn).length;

async function startNativeTurn(
  sessionMode: "plan" | "build",
  mode: "plan" | "build",
  tab = "tab-1",
) {
  const identity = {
    environmentId: environment.id,
    agent: platform,
    logicalSessionKey: `env-${environment.id}:${tab}`,
    origin: "interactive-native",
  };
  await backend.invoke("ensure_native_agent_session", {
    ...identity,
    sessionMode,
    ...modelFields,
  });
  await backend.invoke("dispatch_native_agent_prompt", {
    ...identity,
    mode,
    prompt: `Do the fixture task in ${tab}. ${ORIGINAL}`,
    requestId: randomUUID(),
  });
}

/** Long enough that a loop or a second resend would have shown itself. */
const SETTLE_MS = 20_000;

try {
  switch (scenario) {
    case "native-build":
      await startNativeTurn("build", "build");
      await until(() => resends() >= 1, "the resend");
      await Bun.sleep(SETTLE_MS);
      break;
    case "native-plan-turn":
      await startNativeTurn("build", "plan");
      await until(() => resends() >= 1, "the resend");
      await Bun.sleep(SETTLE_MS);
      break;
    case "native-two-tabs":
      await Promise.all([
        startNativeTurn("build", "build", "tab-1"),
        startNativeTurn("build", "build", "tab-2"),
      ]);
      await until(() => resends() >= 2, "both tabs' resends");
      await Bun.sleep(SETTLE_MS);
      break;
    case "native-other-limit":
    case "native-all-out":
      await startNativeTurn("build", "build");
      await until(() => refusals() >= 1, "the refusal");
      await Bun.sleep(SETTLE_MS);
      break;
    case "multi-review":
      await startMultiReview();
      await until(() => resends() >= 1, "a reviewer's resend");
      await Bun.sleep(SETTLE_MS);
      break;
    case "build-pipeline":
      await startBuildPipeline();
      await until(() => resends() >= 1, "the stage's resend");
      await Bun.sleep(SETTLE_MS);
      break;
    case "graph-run":
      await startGraphRun();
      await until(() => resends() >= 1, "the agent node's resend");
      await Bun.sleep(SETTLE_MS);
      break;
    case "graph-panel":
      await startReviewerPanel();
      await until(() => resends() >= 2, "both reviewers' resends");
      await Bun.sleep(SETTLE_MS);
      break;
  }
  noteBridge();
  clearInterval(bridgeWatch);

  const store = await storage.agentAccounts.loadAgentAccounts();
  const nameOf = (id: string | undefined) =>
    STACK_ACCOUNT_NAMES.find((name) => accountIds[name] === id) ?? id ?? "host";
  const launches = readLaunches();
  const evidence: StackEvidence = {
    calls: summary(),
    usageReadsAfterRefusal: provider.usageReads.filter(
      (read) => read.at >= (provider.firstRefusalAt ?? Infinity),
    ).length,
    bridgePids,
    active: nameOf(store.active[platform]),
    lastSwitchReason: store.autoSwitch?.[platform]?.lastSwitch?.reason,
    pinned: Boolean(store.autoSwitch?.[platform]?.pin),
    loginsUnchanged: STACK_ACCOUNT_NAMES.every(
      (name) => readFileSync(path.join(accountHome(name), credentialFile), "utf8") === logins[name],
    ),
    launches: launches.map((launch) => ({
      account: nameOf(path.basename(launch.home)),
      permissionMode: launch.permissionMode,
      resumed: launch.resumed,
    })),
  };
  console.log(`${STACK_EVIDENCE_PREFIX}${JSON.stringify(evidence)}`);
} finally {
  clearInterval(bridgeWatch);
  await backend.shutdown();
  endpoint.stop();
}
process.exit(0);

/** What the CLI wrapper recorded of each launch (`writeCliWrapper`). */
function readLaunches(): Array<{ home: string; permissionMode?: string; resumed: boolean }> {
  let text = "";
  try {
    text = readFileSync(path.join(paths.root, "cli-launches.log"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { home: string; args: string[] })
    .filter(({ args }) => args[0] !== "--version" && args[0] !== "-v")
    .map(({ home, args }) => ({
      home,
      ...(args.find((arg) => arg.startsWith("--permission-mode="))
        ? {
            permissionMode: args
              .find((arg) => arg.startsWith("--permission-mode="))!
              .slice("--permission-mode=".length),
          }
        : {}),
      resumed: args.some((arg) => arg.startsWith("--resume")),
    }));
}

async function startMultiReview(): Promise<void> {
  const model = { agent: platform, ...modelFields };
  await context.multiReviews!.start({
    environmentId: environment.id,
    projectId: project.id,
    targetBranch: "main",
    reviewInstruction: `Review the fixture change. ${ORIGINAL}`,
    autoFix: false,
    autoPr: false,
    reviewers: [model, model],
    fixModel: model,
  });
}

async function startBuildPipeline(): Promise<void> {
  await backend.invoke("start_build_pipeline", {
    taskId: "fixture-task",
    projectId: project.id,
    environmentType: "local",
    agentType: platform,
    taskTitle: "Fixture task",
    taskSnapshot: {
      title: "Fixture task",
      description: `Do the fixture task. ${ORIGINAL}`,
      acceptanceCriteria: "The fixture passes",
      comments: [],
      images: [],
    },
    existingEnvironmentId: environment.id,
  });
}

/**
 * Two reviewers on one bridge, as a Multi Review's panel is: a graph of only that
 * node, because a real package needs a preparation result and a validation run first.
 */
async function startReviewerPanel(): Promise<void> {
  const ref = { scope: "user", id: "fixture-panel" };
  await backend.invoke("graph_template_save", {
    template: {
      format: "orkestrator.graph",
      formatVersion: 1,
      id: ref.id,
      revision: 0,
      name: "Fixture panel",
      description: "Two reviewers on one bridge.",
      parameters: [],
      roles: [{ key: "reviewer", multiplicity: "panel", maxPanel: 2 }],
      inputs: [],
      outputs: [],
      workspace: { kind: "environment" },
      nodes: [
        {
          id: "review",
          kind: "agent",
          role: "reviewer",
          replicate: { over: "panel", role: "reviewer" },
          capabilities: { profile: "reviewer" },
          workspaceAccess: "read",
          prompt: { template: `Review the fixture change. ${ORIGINAL}` },
          inputs: [],
          outputs: [{ name: "report", type: "review-report@1" }],
        },
      ],
      edges: [],
      limits: { maxAgentSessions: 2, maxConcurrentAgents: 2 },
    },
  });
  const binding = { platform, ...modelFields };
  await backend.invoke("graph_run_launch", {
    ref,
    projectId: project.id,
    environment: { kind: "existing", environmentId: environment.id },
    roles: { reviewer: [binding, binding] },
    requestId: randomUUID(),
  });
}

async function startGraphRun(): Promise<void> {
  const { graphTemplateExample } = await import("@orkestrator/protocol/graphs/examples");
  const ref = { scope: "user", id: "fixture-review" };
  await backend.invoke("graph_template_save", {
    template: {
      ...graphTemplateExample("multi-review"),
      id: ref.id,
      name: "Fixture review",
      revision: 0,
    },
  });
  const options = await backend.invoke<{ roles: Array<{ role: { key: string }; panel: boolean }> }>(
    "graph_launch_options",
    { ref, projectId: project.id, environmentId: environment.id },
  );
  const binding = { platform, ...modelFields };
  await backend.invoke("graph_run_launch", {
    ref,
    projectId: project.id,
    environment: { kind: "existing", environmentId: environment.id },
    roles: Object.fromEntries(
      options.roles.map((role) => [role.role.key, role.panel ? [binding] : binding]),
    ),
    requestId: randomUUID(),
  });
}
