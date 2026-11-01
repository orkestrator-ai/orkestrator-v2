/**
 * Approving a Codex command never saves a rule, against the **real** pinned
 * `codex app-server` binary (todo 0160).
 *
 * Codex proposes an exec-policy amendment on a command approval, and
 * accepting it writes a rule into `CODEX_HOME/rules/` that every later Codex
 * session on the host obeys. app-server has no method to list or remove
 * those rules, so the bridge neither offers nor sends the amendment. A
 * loopback Responses endpoint plays the model: each turn runs one code-mode
 * `exec` cell with the same command, which an `untrusted` approval policy
 * sends for approval. The test watches the raw request (proving Codex did
 * propose an amendment), approves through the bridge, and checks that the
 * throwaway Codex home holds no rule and the identical command asks again in
 * the next turn. A control answers the same request with the amendment
 * itself, written straight to app-server's stdin as the bridge did before,
 * and finds the saved rule; that proves the check looks in the right place.
 * A third run applies an Orkestrator permission rule (todo 0723) the way the
 * backend does: the first approval is answered by a person and remembered as
 * a rule in Orkestrator's own (here in-memory) store, the identical command in
 * the next turn is answered allow-once by the rule, and after the rule is
 * removed the third turn asks the person again. Codex asks every time and its
 * rules folder stays empty: the rule never reaches Codex's own files.
 * Nothing reaches a model and no credits are spent. Gated like the other live
 * contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts
 *
 * The same checks for a managed-network approval run under a second gate.
 * Codex only asks about a host when `/etc/codex/requirements.toml` enables its
 * network proxy, so they run in a disposable container:
 *
 *   mise run verify:codex:network-approval
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  codexRuleEntries,
  commandArgv,
  findPermissionRule,
  permissionRuleOffer,
  type NativeAgentPermissionRule,
} from "@orkestrator/protocol/permission-rules";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { ApprovalRequest } from "./approvals.js";
import { resolveCodexBinary } from "./live-binary.js";

// See `live-contract.test.ts`: the test preload replaces `Response`, and
// `Bun.serve` only accepts its own.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const NativeResponse =
  (globalThis as typeof globalThis & { [key: symbol]: { Response?: typeof Response } | undefined })[
    NATIVE_WEB_PLATFORM_KEY
  ]?.Response ?? Response;

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;
const describeLiveNetwork =
  process.env.RUN_LIVE_CODEX_NETWORK_APPROVAL === "1" ? describe : describe.skip;

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const TOUCHED = "policy-amendment-probe.txt";
const CELL = `text(JSON.stringify(await tools.exec_command({ cmd: "touch ${TOUCHED}" })));`;
const NETWORK_HOST = "policy-amendment-probe.example.test";
const NETWORK_CELL = `text(JSON.stringify(await tools.exec_command({ cmd: "curl -sS --max-time 5 http://${NETWORK_HOST}/" })));`;
const APPROVAL_METHOD = "item/commandExecution/requestApproval";

const POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: true,
  networkAccess: "full",
};

/**
 * A Responses WebSocket: a prewarm gets an empty response, each turn's first
 * sample runs `cell`, and its second ends the turn.
 */
function startScriptedResponses(cell: string) {
  let sampled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new NativeResponse("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as { type?: string; generate?: boolean };
        if (frame.type !== "response.create") return;
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          sampled += 1;
          const item =
            sampled % 2 === 1
              ? {
                  type: "custom_tool_call",
                  id: `ctc_probe_${sampled}`,
                  call_id: `call_probe_${sampled}`,
                  name: "exec",
                  input: cell,
                  status: "completed",
                }
              : {
                  type: "message",
                  id: `msg_probe_${sampled}`,
                  role: "assistant",
                  content: [{ type: "output_text", text: "done", annotations: [] }],
                  status: "completed",
                };
          send({ type: "response.output_item.done", output_index: 0, item });
        }
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}

interface RawApproval {
  id: unknown;
  params: Record<string, unknown>;
}

/**
 * The real spawn, with a second reader on the child's stdout that keeps every
 * approval request. It only observes: the supervisor's own reader still
 * answers each request. `child` is kept for the control's direct answer.
 */
function observingSpawn(probe: {
  seen: RawApproval[];
  child?: ReturnType<typeof spawn>;
}): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    probe.child = child;
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        try {
          const message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
          if (message.method === APPROVAL_METHOD && message.params) {
            probe.seen.push({
              id: message.id,
              params: message.params as Record<string, unknown>,
            });
          }
        } catch {
          // Not a JSON-RPC line; the supervisor's reader reports those.
        }
      }
    });
    return child;
  }) as typeof spawn;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function savedRules(codexHome: string): Promise<string[]> {
  const rules = join(codexHome, "rules");
  return existsSync(rules) ? await readdir(rules, { recursive: true }) : [];
}

/**
 * How each approval is answered. `bridge` and `bridge-session` go through the
 * bridge, as the card's Approve and Approve for session do. The `raw-*` answers
 * write app-server's own amendment straight to its stdin, which is what the
 * bridge sent for "Approve with command policy" and "Approve with network
 * policy" before todo 0160. `orkestrator-rule` is the run in the file comment.
 */
type ProbeAnswer =
  | "bridge"
  | "bridge-session"
  | "raw-amendment"
  | "raw-network-allow"
  | "raw-network-deny"
  | "orkestrator-rule";

function rawAmendment(answer: ProbeAnswer, params: Record<string, unknown>): unknown {
  if (answer === "raw-amendment") {
    return {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment },
    };
  }
  const proposed = params.proposedNetworkPolicyAmendments as Array<{ action: string }>;
  const action = answer === "raw-network-allow" ? "allow" : "deny";
  return {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: proposed.find((entry) => entry.action === action),
    },
  };
}

/**
 * The bridge's engine on a throwaway Codex home and a loopback model. `network`
 * turns on Codex's managed proxy and has each turn reach {@link NETWORK_HOST}
 * under `on-request`, so the only approval is the one about the host.
 */
async function withProbe<T>(
  answer: ProbeAnswer,
  options: { network?: boolean },
  body: (probe: {
    codexHome: string;
    raw: RawApproval[];
    presented: ApprovalRequest[];
    answeredBy: Array<"person" | "rule">;
    rules: NativeAgentPermissionRule[];
    newThread: () => Promise<string>;
    runTurn: (thread: string) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-amendment-home-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-amendment-ws-")));
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  const responses = startScriptedResponses(options.network ? NETWORK_CELL : CELL);
  const probe: { seen: RawApproval[]; child?: ReturnType<typeof spawn> } = { seen: [] };
  const engine = new AppServerEngine({
    codexPath: await resolveCodexBinary(),
    cwd: workspace,
    codexHome,
    clientInfo: CLIENT_INFO,
    // The bridge's own process overrides, as `index.ts` launches it.
    configOverrides: {
      ...codexAppServerConfigOverrides({}),
      openai_base_url: JSON.stringify(responses.baseUrl),
      ...(options.network
        ? {
            "features.network_proxy.enabled": "true",
            "features.network_proxy.mode": JSON.stringify("limited"),
          }
        : {}),
    },
    supervisorOverrides: { pidFileEnabled: false, spawnProcess: observingSpawn(probe) },
  });
  const presented: ApprovalRequest[] = [];
  // Orkestrator's rule store and who answered each approval, for the rule run.
  const rules: NativeAgentPermissionRule[] = [];
  const answeredBy: Array<"person" | "rule"> = [];
  engine.setApprovalHandlers({
    present: (request) => {
      presented.push(request);
      setTimeout(() => {
        if (answer === "orkestrator-rule") {
          const subject = { kind: "command" as const, command: request.command ?? "" };
          const context = {
            provider: "codex" as const,
            projectId: "project-1",
            environmentId: "env-1",
            workspaceRoot: workspace,
            now: Date.now(),
          };
          const rule = request.ruleEligible ? findPermissionRule(rules, subject, context) : null;
          if (!rule && request.ruleEligible) {
            // A person clicks "Approve and remember" with the preselected pattern.
            const offer = permissionRuleOffer(
              subject,
              request.proposedCommandPrefix ? { proposal: request.proposedCommandPrefix } : {},
            );
            const pattern = offer.patterns[offer.suggested];
            if (pattern && rules.length === 0 && answeredBy.length === 0) {
              rules.push({
                id: "rule-1",
                provider: "codex",
                scope: "project",
                projectId: "project-1",
                kind: offer.kind,
                pattern,
                createdAt: Date.now(),
                createdFrom: {
                  environmentId: "env-1",
                  agent: "codex",
                  interactionId: request.approvalId,
                },
                useCount: 0,
              });
            }
          }
          answeredBy.push(rule ? "rule" : "person");
          // Either way the wire answer is the plain allow-once approve.
          engine.resolveApproval(request.approvalId, "approve");
          return;
        }
        if (answer === "bridge") {
          // Approve alone: the card's only approve button.
          engine.resolveApproval(request.approvalId, "approve");
          return;
        }
        if (answer === "bridge-session") {
          engine.resolveApproval(request.approvalId, "approve-for-session");
          return;
        }
        const raw = probe.seen.at(-1)!;
        probe.child!.stdin!.write(
          `${JSON.stringify({
            id: raw.id,
            result: { decision: rawAmendment(answer, raw.params) },
          })}\n`,
        );
      }, 50);
      return true;
    },
    resolved: () => undefined,
  });
  let completed: (() => void) | undefined;
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed?.();
  });
  const config: EngineTurnConfig = options.network
    ? {
        mode: "build",
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        policy: POLICY,
      }
    : {
        mode: "build",
        cwd: workspace,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        policy: POLICY,
      };
  try {
    await engine.start();
    return await body({
      codexHome,
      raw: probe.seen,
      presented,
      answeredBy,
      rules,
      newThread: async () => (await engine.startThread({ config })).handle,
      runTurn: async (thread) => {
        const turnCompleted = new Promise<void>((resolve) => {
          completed = resolve;
        });
        await engine.startTurn({
          handle: thread,
          input: [{ type: "text", text: "Run the probe." }],
          config,
        });
        await withTimeout(turnCompleted, 60_000, "the turn to complete");
      },
    });
  } finally {
    await engine.stop();
    await responses.stop();
  }
}

/** Runs `turns` turns of the same command on one thread. */
async function runProbe(answer: ProbeAnswer, turns = 2, options: { network?: boolean } = {}) {
  return withProbe(answer, options, async (probe) => {
    const thread = await probe.newThread();
    const rulesAfterTurn: string[][] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      // The rule is removed before the last turn of the rule run.
      if (answer === "orkestrator-rule" && turn === turns - 1) probe.rules.length = 0;
      await probe.runTurn(thread);
      rulesAfterTurn.push(await savedRules(probe.codexHome));
    }
    return {
      raw: probe.raw.map((entry) => entry.params),
      presented: probe.presented,
      rulesAfterTurn,
      answeredBy: probe.answeredBy,
    };
  });
}

/**
 * Saves a rule with a `raw-*` answer, then removes it the way Settings →
 * Permissions tells a user to. Returns what each step asked and what the rules
 * file listed. A thread reads the rules once, when it starts: the one already
 * running keeps the removed rule, and a new one asks again.
 */
async function runSavedRuleLifecycle(answer: ProbeAnswer, options: { network?: boolean } = {}) {
  return withProbe(answer, options, async (probe) => {
    const rulesFile = join(probe.codexHome, "rules", "default.rules");
    const asks: Record<string, number> = {};
    const step = async (name: string, thread: string) => {
      const before = probe.raw.length;
      await probe.runTurn(thread);
      asks[name] = probe.raw.length - before;
    };
    const running = await probe.newThread();
    await step("saved", running);
    const listed = codexRuleEntries(await readFile(rulesFile, "utf8"));
    await step("same thread", running);
    await step("new thread", await probe.newThread());
    await rm(rulesFile);
    await step("removed, running thread", running);
    await step("removed, new thread", await probe.newThread());
    return { asks, listed };
  });
}

/** What {@link runSavedRuleLifecycle} expects of any saved rule. */
const SAVED_RULE_ASKS = {
  saved: 1,
  "same thread": 0,
  "new thread": 0,
  "removed, running thread": 0,
  "removed, new thread": 1,
};

describeLive("live policy amendment", () => {
  test("approving a command that proposes an exec-policy amendment saves no rule", async () => {
    const result = await runProbe("bridge");
    // Codex proposed a rule for the command...
    expect(result.raw[0]?.proposedExecpolicyAmendment).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    // ...the card was not offered it, and approving saved nothing.
    expect(result.presented[0]?.command).toContain(TOUCHED);
    expect(result.presented[0]).not.toHaveProperty("amendments");
    // The identical command asks again: nothing was remembered.
    expect(result.raw).toHaveLength(2);
    expect(result.presented).toHaveLength(2);
    expect(result.presented[1]?.command).toBe(result.presented[0]?.command);
    expect(result.rulesAfterTurn).toEqual([[], []]);
  }, 180_000);

  test("accepting the amendment itself saves a rule and stops the next ask (control)", async () => {
    const result = await runProbe("raw-amendment");
    expect(result.raw[0]?.proposedExecpolicyAmendment).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(result.rulesAfterTurn[0]).toEqual(["default.rules"]);
    // The saved rule answers the identical command, so it never asks again.
    expect(result.raw).toHaveLength(1);
    expect(result.presented).toHaveLength(1);
  }, 180_000);

  test("a saved command rule is listed, and once removed a new thread asks again", async () => {
    const result = await runSavedRuleLifecycle("raw-amendment");
    expect(result.listed).toEqual([
      `prefix_rule(pattern=["touch", "${TOUCHED}"], decision="allow")`,
    ]);
    expect(result.asks).toEqual(SAVED_RULE_ASKS);
  }, 240_000);

  test("Approve for session saves no rule and ends with the thread", async () => {
    const result = await withProbe("bridge-session", {}, async (probe) => {
      const thread = await probe.newThread();
      await probe.runTurn(thread);
      await probe.runTurn(thread);
      const asksInThread = probe.raw.length;
      await probe.runTurn(await probe.newThread());
      return {
        asksInThread,
        asksAfterNewThread: probe.raw.length,
        rules: await savedRules(probe.codexHome),
      };
    });
    expect(result).toEqual({ asksInThread: 1, asksAfterNewThread: 2, rules: [] });
  }, 180_000);

  test("an Orkestrator rule answers the identical command, and asks again once removed", async () => {
    const result = await runProbe("orkestrator-rule", 3);
    // Codex asked every time: the rule lives only in Orkestrator.
    expect(result.raw).toHaveLength(3);
    expect(result.presented).toHaveLength(3);
    // The real Codex command is exact enough for a rule to match it.
    expect(result.presented[0]?.ruleEligible).toBe(true);
    expect(commandArgv(result.presented[0]!.command!)).toEqual(["touch", TOUCHED]);
    expect(result.answeredBy).toEqual(["person", "rule", "person"]);
    // Every answer was allow-once, so Codex saved nothing.
    expect(result.rulesAfterTurn).toEqual([[], [], []]);
  }, 240_000);
});

describeLiveNetwork("live managed-network approval", () => {
  const networkRule = (decision: "allow" | "deny", verb: string) =>
    `network_rule(host="${NETWORK_HOST}", protocol="http", decision="${decision}", justification="${verb} http access to ${NETWORK_HOST}")`;

  test("Approve on a host saves no rule, and the next request asks again", async () => {
    const result = await runProbe("bridge", 2, { network: true });
    // Codex proposed both a durable allow and a durable deny, and sent no command...
    expect(result.raw[0]?.proposedNetworkPolicyAmendments).toEqual([
      { host: NETWORK_HOST, action: "allow" },
      { host: NETWORK_HOST, action: "deny" },
    ]);
    expect(result.raw[0]?.command).toBeUndefined();
    // ...the card can approve it, and offers neither.
    expect(result.presented[0]?.networkHost).toBe(NETWORK_HOST);
    expect(result.presented[0]?.actionable).toBe(true);
    expect(result.presented[0]?.ruleEligible).toBe(true);
    expect(result.presented[0]).not.toHaveProperty("amendments");
    expect(result.presented).toHaveLength(2);
    expect(result.rulesAfterTurn).toEqual([[], []]);
  }, 180_000);

  test("Approve for session saves no rule and ends with the thread", async () => {
    const result = await withProbe("bridge-session", { network: true }, async (probe) => {
      const thread = await probe.newThread();
      await probe.runTurn(thread);
      await probe.runTurn(thread);
      const asksInThread = probe.raw.length;
      await probe.runTurn(await probe.newThread());
      return {
        asksInThread,
        asksAfterNewThread: probe.raw.length,
        rules: await savedRules(probe.codexHome),
      };
    });
    expect(result).toEqual({ asksInThread: 1, asksAfterNewThread: 2, rules: [] });
  }, 180_000);

  test("an accepted allow amendment is one network_rule line in rules/default.rules (control)", async () => {
    const result = await runSavedRuleLifecycle("raw-network-allow", { network: true });
    expect(result.listed).toEqual([networkRule("allow", "Allow")]);
    expect(result.asks).toEqual(SAVED_RULE_ASKS);
  }, 240_000);

  test("an accepted deny amendment is stored the same way (control)", async () => {
    const result = await runSavedRuleLifecycle("raw-network-deny", { network: true });
    expect(result.listed).toEqual([networkRule("deny", "Deny")]);
    expect(result.asks).toEqual(SAVED_RULE_ASKS);
  }, 240_000);
});
