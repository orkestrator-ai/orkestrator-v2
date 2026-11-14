// Proves on the real pinned Claude CLI that the sandbox `claudeExecutionSandbox`
// asks for is enforced, not just set (to-do 0001 task 9). Run by
// `claude-provider-sandbox.live.test.ts` in its own process, because the
// session-manager suites replace the SDK with a mock.
//
// The whole bridge runs here, through its own routes (`app.request`, no port
// bound): session create with an execution policy, prompt, interactions,
// close. Each turn's model is a scripted loopback endpoint that asks for one
// Bash call, so the bridge's own option building, the real CLI and the
// host's sandbox (Seatbelt on macOS, bubblewrap on Linux) decide what the
// command can do. The
// command's targets are a scratch directory beside the workspace and a
// loopback server this probe starts, never a real user path or a public host.
//
// Credential-free: HOME and CLAUDE_CONFIG_DIR are a temporary directory the
// test creates and removes, the API key is a fixture string, and
// non-essential traffic is off. Nothing is billed.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

export const RESULT_SENTINEL = "__CLAUDE_PROVIDER_SANDBOX_RESULT__";

/** One scripted turn: a single Bash call, then "Done.". */
export interface SandboxScenario {
  name: string;
  policy: NativeAgentExecutionPolicy;
  /** The Bash command, given the scratch paths and this turn's unlisted URL. */
  command: (paths: { workspace: string; outside: string; url: string }) => string;
  dangerouslyDisableSandbox?: boolean;
  /** The file the command tries to create, and in which scratch directory. */
  writes?: { in: "workspace" | "outside"; name: string };
  /** Approve each tool approval the turn raises; otherwise decline it. */
  approve?: boolean;
}

export interface SandboxObservation {
  name: string;
  /** The tool result the CLI returned to the model for the Bash call. */
  toolResult: { isError: boolean; excerpt: string } | null;
  /** Whether the file the command tried to create exists afterwards. */
  wrote: boolean | null;
  /** Requests the unlisted loopback server received from this turn. */
  unlistedHits: number;
  /** Every tool approval the bridge raised during the turn. */
  approvals: Array<{ kind: string; toolName?: string }>;
  /** File existence while each approval is still pending, before answering it. */
  writesBeforeApproval: boolean[];
  questions: number;
  activity: string;
  modelCalls: number;
}

export interface SandboxReport {
  platform: NodeJS.Platform;
  /** What the CLI under test reports from `--version`. */
  cliVersion: string;
  observations: SandboxObservation[];
}

/**
 * What each OS's sandbox does where the two implementations differ, as
 * observed on the pinned CLI (macOS 2026-11-06, Linux 2026-11-10).
 */
export interface PlatformSandboxExpectations {
  /**
   * The shell's error for a write outside the writable paths, compared
   * case-insensitively: bash and zsh word the same errno differently.
   */
  outsideWriteRefusal: string;
  /**
   * Whether a direct loopback request reaches the host with full network.
   * `allowLocalBinding` is macOS-only: bubblewrap gives each command its own
   * network namespace, so on Linux only the proxy leads out of it.
   */
  directLoopbackWithFullNetwork: boolean;
}

export const PLATFORM_SANDBOX_EXPECTATIONS: Partial<
  Record<NodeJS.Platform, PlatformSandboxExpectations>
> = {
  // Seatbelt denies the open() itself.
  darwin: { outsideWriteRefusal: "operation not permitted", directLoopbackWithFullNetwork: true },
  // bubblewrap binds everything outside the writable paths read-only.
  linux: { outsideWriteRefusal: "Read-only file system", directLoopbackWithFullNetwork: false },
};

/**
 * Whether the live check can run here, and why not. macOS's Seatbelt always
 * starts; Linux needs bubblewrap that can nest the CLI's user namespace,
 * which the bridge itself checks (it would refuse every turn with 422);
 * anything else has no sandbox the check covers.
 */
export function providerSandboxLiveGate(
  platform: NodeJS.Platform,
  linuxSandbox: () => { available: boolean; reason?: string },
): { run: true } | { run: false; reason: string } {
  if (platform === "darwin") return { run: true };
  if (platform !== "linux") {
    return { run: false, reason: `no Claude command sandbox is qualified on ${platform}` };
  }
  const status = linuxSandbox();
  return status.available
    ? { run: true }
    : { run: false, reason: status.reason ?? "the Linux sandbox probe failed" };
}

const TURN_TIMEOUT_MS = 90_000;
const POLL_MS = 100;
// The tool result's head: enough for the shell's or the proxy's refusal.
const EXCERPT_CHARS = 400;
const MARKER = /\[sandbox-probe:([a-z0-9-]+)\]/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const providerSandbox = (
  approvals: NativeAgentExecutionPolicy["approvals"],
  networkAccess: NativeAgentExecutionPolicy["networkAccess"] = "restricted",
): NativeAgentExecutionPolicy => ({
  id: "interactive-host",
  sandbox: "provider",
  approvals,
  projectResources: false,
  networkAccess,
});

/**
 * A request to the unlisted loopback server. The sandbox's `NO_PROXY` names
 * loopback and the private ranges, so a plain request connects directly and
 * meets Seatbelt's network rule (macOS) or the command's own empty network
 * namespace (Linux); `--noproxy ''` sends it through the sandbox proxy
 * instead, which is where `strictAllowlist` is decided.
 */
const curl = (url: string, route: "direct" | "proxy") =>
  `curl ${route === "proxy" ? "--noproxy '' " : ""}--silent --show-error --fail --max-time 5 '${url}'`;

const writeTo = (directory: string, name: string) => `printf probe > '${join(directory, name)}'`;

/**
 * Every turn the probe runs, in order. `control-*` turns show that the
 * command works and that the same request is reached or asked about when the
 * policy allows it, so each refusal in the other turns is the sandbox's.
 */
export const SCENARIOS: SandboxScenario[] = [
  {
    name: "control-unsandboxed",
    policy: {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    },
    command: ({ outside, url }) =>
      `${writeTo(outside, "control-unsandboxed")} && ${curl(url, "direct")}`,
    writes: { in: "outside", name: "control-unsandboxed" },
  },
  {
    // A sandboxed command still runs and may write its workspace.
    name: "control-workspace-write",
    policy: providerSandbox("auto-approve"),
    command: ({ workspace }) => writeTo(workspace, "control-workspace-write"),
    writes: { in: "workspace", name: "control-workspace-write" },
  },
  {
    // `allowLocalBinding` with full network: loopback is reachable directly
    // on macOS. On Linux (where that option does not apply) it is not, which
    // the test asserts as the platform's documented difference.
    name: "control-direct-full",
    policy: providerSandbox("auto-approve", "full"),
    command: ({ url }) => curl(url, "direct"),
  },
  {
    // Without `strictAllowlist` the proxy turns an unlisted host into a
    // permission request, which an auto-approving turn grants unseen...
    name: "control-proxy-full",
    policy: providerSandbox("auto-approve", "full"),
    command: ({ url }) => curl(url, "proxy"),
  },
  {
    // ...and an asking turn shows as a second card.
    name: "control-proxy-full-ask",
    policy: providerSandbox("ask", "full"),
    command: ({ url }) => curl(url, "proxy"),
    approve: true,
  },
  {
    name: "write-outside",
    policy: providerSandbox("auto-approve"),
    command: ({ outside }) => writeTo(outside, "write-outside"),
    writes: { in: "outside", name: "write-outside" },
  },
  {
    // `allowUnsandboxedCommands: false`: the model's escape request is ignored.
    name: "write-outside-escape",
    policy: providerSandbox("auto-approve"),
    command: ({ outside }) => writeTo(outside, "write-outside-escape"),
    dangerouslyDisableSandbox: true,
    writes: { in: "outside", name: "write-outside-escape" },
  },
  {
    // `ask` permits an escape only after a visible Bash approval is accepted.
    name: "write-outside-escape-ask-accept",
    policy: providerSandbox("ask"),
    command: ({ outside }) => writeTo(outside, "write-outside-escape-ask-accept"),
    dangerouslyDisableSandbox: true,
    writes: { in: "outside", name: "write-outside-escape-ask-accept" },
    approve: true,
  },
  {
    // Declining the same escape must leave the outside file absent.
    name: "write-outside-escape-ask-decline",
    policy: providerSandbox("ask"),
    command: ({ outside }) => writeTo(outside, "write-outside-escape-ask-decline"),
    dangerouslyDisableSandbox: true,
    writes: { in: "outside", name: "write-outside-escape-ask-decline" },
  },
  {
    name: "network-direct",
    policy: providerSandbox("auto-approve"),
    command: ({ url }) => curl(url, "direct"),
  },
  {
    name: "network-direct-escape",
    policy: providerSandbox("auto-approve"),
    command: ({ url }) => curl(url, "direct"),
    dangerouslyDisableSandbox: true,
  },
  {
    // `strictAllowlist`: the proxy refuses an unlisted host outright.
    name: "network-proxy",
    policy: providerSandbox("auto-approve"),
    command: ({ url }) => curl(url, "proxy"),
  },
  {
    name: "network-proxy-escape",
    policy: providerSandbox("auto-approve"),
    command: ({ url }) => curl(url, "proxy"),
    dangerouslyDisableSandbox: true,
  },
  {
    // Under `ask` the Bash call itself is a card; approving it must not be
    // followed by a second card for the unlisted host.
    name: "network-proxy-ask",
    policy: providerSandbox("ask"),
    command: ({ url }) => curl(url, "proxy"),
    approve: true,
  },
];

type Block = {
  type?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Block[];
};
type MessagesBody = {
  messages?: Array<{ role?: string; content?: string | Block[] }>;
  tools?: Array<{ name?: string }>;
  stream?: boolean;
};

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

type ScriptedBlock =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string };

function reply(content: ScriptedBlock[], stream: boolean, id: number): Response {
  const toolTurn = content.some((block) => block.type === "tool_use");
  const message = {
    id: `msg_probe_${id}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: toolTurn ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!stream) return Response.json(message);
  const events: Array<{ type: string } & Record<string, unknown>> = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
  ];
  for (const [index, block] of content.entries()) {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text },
    });
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * The CLI the SDK bundles (what a bridge runs when `CLAUDE_CLI_PATH` is
 * unset), or `ORKESTRATOR_POLICY_CLAUDE_PATH`. The report carries its
 * version so the test can hold it to the pinned toolchain.
 */
function bundledCli(): string {
  const explicit = process.env.ORKESTRATOR_POLICY_CLAUDE_PATH?.trim();
  if (explicit) return explicit;
  const sdk = dirname(
    Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", import.meta.dir),
  );
  const target = `${process.platform}-${process.arch}`;
  return join(
    dirname(Bun.resolveSync(`@anthropic-ai/claude-agent-sdk-${target}/package.json`, sdk)),
    "claude",
  );
}

/** Runs `scenarios` one after another, in this process, in the workspace `CWD` names. */
async function runScenarios(scenarios: SandboxScenario[]): Promise<SandboxReport> {
  const workspace = process.env.CWD;
  const outside = process.env.SANDBOX_PROBE_OUTSIDE;
  if (!workspace || !outside || !process.env.CLAUDE_CONFIG_DIR) {
    throw new Error("The probe needs CWD, SANDBOX_PROBE_OUTSIDE and CLAUDE_CONFIG_DIR");
  }
  const cli = bundledCli();
  if (!existsSync(cli)) throw new Error("The pinned Claude CLI is not installed");
  const version = Bun.spawnSync([cli, "--version"], { env: process.env, stderr: "ignore" })
    .stdout.toString()
    .trim()
    .split(/\s/)[0]!;

  const unlistedHits = new Map<string, number>();
  const unlisted = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const key = new URL(request.url).pathname.slice(1);
      unlistedHits.set(key, (unlistedHits.get(key) ?? 0) + 1);
      return new Response("unlisted fixture\n");
    },
  });
  const unlistedOrigin = unlisted.url.origin;

  const byName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
  const results = new Map<string, { isError: boolean; excerpt: string }>();
  const modelCalls = new Map<string, number>();
  let sequence = 0;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sequence += 1;
      if (request.method !== "POST") return Response.json({ data: [] });
      const body = (await request.json().catch(() => ({}))) as MessagesBody;
      if (!new URL(request.url).pathname.endsWith("/messages")) {
        return Response.json({ input_tokens: 1 });
      }
      const users = (body.messages ?? []).filter((message) => message.role === "user");
      const name = users.map((message) => MARKER.exec(textOf(message.content))?.[1]).find(Boolean);
      const scenario = name ? byName.get(name) : undefined;
      const bash = (body.tools ?? []).some((tool) => tool.name === "Bash");
      if (!scenario || !bash) {
        return reply([{ type: "text", text: "Probe." }], body.stream === true, sequence);
      }
      modelCalls.set(scenario.name, (modelCalls.get(scenario.name) ?? 0) + 1);
      const toolId = `toolu_probe_${scenario.name.replaceAll("-", "_")}`;
      const result = users
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((block) => block.type === "tool_result" && block.tool_use_id === toolId);
      if (result) {
        results.set(scenario.name, {
          isError: result.is_error === true,
          excerpt: textOf(result.content).slice(0, EXCERPT_CHARS),
        });
        return reply([{ type: "text", text: "Done." }], body.stream === true, sequence);
      }
      return reply(
        [
          {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: {
              command: scenario.command({
                workspace,
                outside,
                url: `${unlistedOrigin}/${scenario.name}`,
              }),
              description: "Sandbox qualification probe",
              ...(scenario.dangerouslyDisableSandbox ? { dangerouslyDisableSandbox: true } : {}),
            },
          },
        ],
        body.stream === true,
        sequence,
      );
    },
  });

  process.env.ANTHROPIC_BASE_URL = model.url.origin;
  process.env.CLAUDE_CLI_PATH = cli;
  process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
  process.env.CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
  const { app } = await import("../index.js");
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Route bodies are read field by field below; a missing field fails the turn.
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  const observations: SandboxObservation[] = [];
  try {
    for (const scenario of scenarios) {
      const created = await call("POST", "/session/create", {
        title: `sandbox ${scenario.name}`,
        policy: scenario.policy,
      });
      if (created.status !== 201) {
        throw new Error(`${scenario.name}: create answered ${created.status}`);
      }
      const id = created.body.sessionId as string;
      const prompt = await call("POST", `/session/${id}/prompt`, {
        prompt: `Run the probe. [sandbox-probe:${scenario.name}]`,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
      });
      if (prompt.status !== 202) {
        throw new Error(`${scenario.name}: prompt answered ${prompt.status}`);
      }
      const approvals = new Map<string, { kind: string; toolName?: string }>();
      const writesBeforeApproval: boolean[] = [];
      const directory = scenario.writes?.in === "workspace" ? workspace : outside;
      const questions = new Set<string>();
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let activity = "unknown";
      // Wait for the model's final call, then for the bridge to settle the turn.
      for (;;) {
        if (Date.now() > deadline) break;
        const interactions = await call("GET", `/session/${id}/interactions`);
        for (const interaction of interactions.body?.interactions ?? []) {
          if (approvals.has(interaction.id)) continue;
          approvals.set(interaction.id, {
            kind: String(interaction.kind),
            ...(typeof interaction.toolName === "string" ? { toolName: interaction.toolName } : {}),
          });
          if (scenario.writes) {
            writesBeforeApproval.push(existsSync(join(directory, scenario.writes.name)));
          }
          const answered = await call("POST", `/session/${id}/interactions/${interaction.id}`, {
            action: scenario.approve ? "accept" : "decline",
          });
          if (answered.status !== 200) {
            throw new Error(`${scenario.name}: approval answer returned ${answered.status}`);
          }
        }
        const pendingQuestions = await call("GET", `/session/${id}/questions`);
        for (const question of pendingQuestions.body?.questions ?? []) questions.add(question.id);
        activity = String((await call("GET", `/session/${id}/activity`)).body?.activity);
        if (results.has(scenario.name) && activity === "idle") break;
        await sleep(POLL_MS);
      }
      // A late request (a retry after the result) still lands in the count.
      await sleep(500);
      observations.push({
        name: scenario.name,
        toolResult: results.get(scenario.name) ?? null,
        wrote: scenario.writes ? existsSync(join(directory, scenario.writes.name)) : null,
        unlistedHits: unlistedHits.get(scenario.name) ?? 0,
        approvals: Array.from(approvals.values()),
        writesBeforeApproval,
        questions: questions.size,
        activity,
        modelCalls: modelCalls.get(scenario.name) ?? 0,
      });
      await call("POST", `/session/${id}/close`);
    }
  } finally {
    model.stop(true);
    unlisted.stop(true);
  }
  return { platform: process.platform, cliVersion: version, observations };
}

/**
 * Child lanes this probe splits the scenarios across. A lane is a process with
 * a workspace, scratch directory, home and bridge of its own: sessions that
 * share one workspace race on the files the CLI keeps in its `.claude`
 * directory, which bubblewrap binds, so the lanes cannot be sessions of one
 * bridge. `SANDBOX_PROBE_LANES=1` runs every scenario in this process.
 */
const DEFAULT_LANES = 4;
const ONLY_ENV = "SANDBOX_PROBE_ONLY";

/** Runs the scenarios in `DEFAULT_LANES` child probes at once and merges their reports. */
async function runLanes(lanes: number): Promise<SandboxReport> {
  const workspace = process.env.CWD;
  const outside = process.env.SANDBOX_PROBE_OUTSIDE;
  const home = process.env.HOME;
  if (!workspace || !outside || !home) {
    throw new Error("The probe needs CWD, SANDBOX_PROBE_OUTSIDE and HOME");
  }
  // Round robin keeps the slow turns (approvals) from landing in one lane.
  const assigned = Array.from({ length: lanes }, (): SandboxScenario[] => []);
  SCENARIOS.forEach((scenario, index) => assigned[index % lanes]!.push(scenario));
  const children = new Set<Bun.Subprocess>();
  const stop = () => {
    for (const child of children) child.kill();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stop();
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  const laneReports = await Promise.allSettled(
    assigned.map(async (scenarios, lane) => {
      // Siblings of the test's directories, so its cleanup removes them too.
      const laneHome = `${home}-lane${lane}`;
      await Promise.all(
        [
          join(laneHome, ".claude"),
          join(laneHome, "gh"),
          join(laneHome, "tmp"),
          `${workspace}-lane${lane}`,
          `${outside}-lane${lane}`,
        ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
      );
      const child = Bun.spawn([process.execPath, import.meta.path], {
        env: {
          ...process.env,
          HOME: laneHome,
          CLAUDE_CONFIG_DIR: join(laneHome, ".claude"),
          GH_CONFIG_DIR: join(laneHome, "gh"),
          // The CLI keeps content-named files (its sandbox settings) in a
          // per-user directory under /tmp and deletes them as it exits,
          // which another running CLI's bubblewrap would then miss.
          CLAUDE_CODE_TMPDIR: join(laneHome, "tmp"),
          CWD: `${workspace}-lane${lane}`,
          SANDBOX_PROBE_OUTSIDE: `${outside}-lane${lane}`,
          [ONLY_ENV]: scenarios.map((scenario) => scenario.name).join(","),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.add(child);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0)
          throw new Error(`lane ${lane} exited ${exitCode}: ${stderr.slice(-4_000)}`);
        const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_SENTINEL));
        if (!line) throw new Error(`lane ${lane} printed no ${RESULT_SENTINEL} line`);
        return JSON.parse(line.slice(RESULT_SENTINEL.length)) as SandboxReport;
      } finally {
        children.delete(child);
        if (child.exitCode === null) child.kill();
      }
    }),
  );
  const failed = laneReports.find((entry) => entry.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  const reports = laneReports.map(
    (entry) => (entry as PromiseFulfilledResult<SandboxReport>).value,
  );
  const order = new Map(SCENARIOS.map((scenario, index) => [scenario.name, index]));
  return {
    platform: reports[0]!.platform,
    cliVersion: reports[0]!.cliVersion,
    observations: reports
      .flatMap((report) => report.observations)
      .sort((a, b) => order.get(a.name)! - order.get(b.name)!),
  };
}

async function main(): Promise<void> {
  const only = process.env[ONLY_ENV];
  const lanes = Number(process.env.SANDBOX_PROBE_LANES ?? DEFAULT_LANES);
  const report = only
    ? await runScenarios(SCENARIOS.filter((scenario) => only.split(",").includes(scenario.name)))
    : lanes > 1
      ? await runLanes(Math.min(lanes, SCENARIOS.length))
      : await runScenarios(SCENARIOS);
  process.stdout.write(`${RESULT_SENTINEL}${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}
