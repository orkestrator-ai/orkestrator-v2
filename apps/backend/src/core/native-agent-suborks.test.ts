/**
 * Suborks end to end against provider fakes: an agent calls `ask_agents` over
 * MCP, targets run on the shared branch runner, and the answers reach the
 * caller's mailbox. No test here reaches a real provider.
 */
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { afterEach, describe, expect, test } from "bun:test";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { SYSTEM_INSTRUCTIONS_FRAME_OPEN } from "@orkestrator/protocol/review-evidence-frames";
import {
  AGENT_SUBORK_TOOL_NAMES,
  SUBORK_LIMITS,
  SUBORK_TOOL_NAME,
} from "@orkestrator/protocol/suborks";
import { AGENT_MAIL_MAX_BODY_BYTES } from "@orkestrator/protocol/agent-mail";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { fakeAgentTools } from "./graph-agent-test-support.js";
import { suborkLatestAction } from "./native-agent-subork-host.js";
import {
  answering,
  suborkWorld,
  type SuborkWorld,
  type SuborkWorldOptions,
} from "./native-agent-suborks-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

const SESSION_KEY = nativeAgentSessionStorageKey("e1", "claude", "env-e1:agent");
const worlds: SuborkWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(options: SuborkWorldOptions = {}): Promise<SuborkWorld> {
  const created = await suborkWorld(options);
  worlds.push(created);
  return created;
}

type Handle = {
  batchId: string;
  next: string;
  suborks: {
    id: string;
    name: string;
    agent?: string;
    model?: string;
    status: string;
    error?: string;
    readOnly?: string;
  }[];
};

const handle = (value: Record<string, unknown>) => value as unknown as Handle;

describe("the tool", () => {
  test("is offered with the same name, description and shape, and says when to use it", async () => {
    const w = await world();
    expect(await w.tools.list()).toContain(SUBORK_TOOL_NAME);
    const response = await fetch(w.agentTools.connection("e1", "p1", "host", "agent").url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${w.agentTools.connection("e1", "p1", "host", "agent").token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list", params: {} }),
    });
    const text = await response.text();
    const body = JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? text,
    ) as {
      result: {
        tools: {
          name: string;
          description: string;
          inputSchema: { properties: Record<string, { items?: { properties: object } }> };
        }[];
      };
    };
    const tool = body.result.tools.find((candidate) => candidate.name === SUBORK_TOOL_NAME)!;
    // What the plain-text form relies on: the backend does not parse natural language.
    expect(tool.description).toContain("asks you to ask");
    expect(tool.description).toContain("ask opus 5.5 and grok 4.7");
    expect(tool.description).toContain("instead of your own sub-agent");
    expect(tool.description).toContain("sees only the prompt");
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      "prompt",
      "requestId",
      "tabId",
      "targets",
    ]);
    expect(Object.keys(tool.inputSchema.properties.targets!.items!.properties).sort()).toEqual([
      "agent",
      "model",
      "name",
      "prompt",
    ]);
  });

  test("every native platform advertises the command's capability", () => {
    for (const agent of AGENT_PLATFORMS) {
      expect(nativeAgentCapabilities(agent).actions?.subork).toBe(true);
    }
    expect(AGENT_SUBORK_TOOL_NAMES).toEqual([SUBORK_TOOL_NAME]);
  });

  test("a turn on the shared connection is refused unless the tab is OpenCode's", async () => {
    const w = await world();
    const shared = fakeAgentTools(w.agentTools.connection("e1", "p1", "host"));
    const result = await shared.call(SUBORK_TOOL_NAME, {
      targets: [{ agent: "codex" }],
      prompt: "hello",
      tabId: "agent",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Suborks can't start suborks");
  });

  test("mail off is a clear refusal, not a call that never answers", async () => {
    const w = await world();
    const config = await w.storage.loadConfig();
    await w.storage.saveConfig({
      ...config,
      global: {
        ...config.global,
        agentMessaging: { ...config.global.agentMessaging!, enabled: false },
      },
    });
    await expect(w.ask({ targets: [{ agent: "codex" }], prompt: "hello" })).rejects.toThrow(
      "Settings → Messaging",
    );
  });
});

describe("/subork ask codex to review this index.html", () => {
  test("runs one read-only subork on Codex's saved default and its answer reaches the caller", async () => {
    const w = await world();
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }], prompt: "Review index.html in the root." }),
    );
    expect(started.suborks).toHaveLength(1);
    expect(started.suborks[0]).toMatchObject({ agent: "codex", model: "gpt-6.1-sol" });
    expect(started.next).toContain("End your turn");
    await w.drive(started.batchId);

    const [mail] = await w.mail();
    expect(mail!.subject).toBe("Subork answers: 1 of 1 finished");
    expect(mail!.body).toContain("Codex · GPT-6.1 Sol");
    expect(mail!.body).toContain("codex says hi");
    // A system-route notice wakes the caller whatever the default inject policy is.
    expect(mail!.placement).toBe("pending-inject");
    expect(w.service.views(SESSION_KEY)![0]).toMatchObject({
      status: "settled",
      delivery: "sent",
    });
  });

  test("the subork receives only its prompt, in a fresh session", async () => {
    const w = await world();
    const prompt = "Review index.html in the root.";
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt }));
    await w.drive(started.batchId);
    const turns = w.provider("codex").turns();
    expect(turns).toHaveLength(1);
    const sent = turns[0]!;
    // Instructions, then the prompt, then the attempt's result instruction: nothing else.
    expect(sent.prompt.startsWith(SYSTEM_INSTRUCTIONS_FRAME_OPEN)).toBe(true);
    const afterFrame = sent.prompt.split("</orkestrator-system-instructions>\n\n")[1]!;
    expect(afterFrame.startsWith(`${prompt}\n\n`)).toBe(true);
    expect(sent.prompt).not.toContain("env-e1:agent");
    // Every session is its own: nothing resumes or forks the caller's conversation.
    const session = w.provider("codex").session(sent.sessionId);
    expect(session.key).toBe(`subork:${started.batchId}:${started.suborks[0]!.id}`);
    expect(session.createOptions).not.toHaveProperty("resumeSessionId");
    expect(session.createOptions).not.toHaveProperty("forkSessionId");
    expect(w.provider("claude").turns()).toHaveLength(0);
  });

  test("it runs read-only with interactions declined, as a read-only session does", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    const sent = w.provider("codex").turns()[0]!;
    expect(sent.options.mode).toBe("plan");
    expect(sent.options.readOnly).toBe(true);
    const created = w.provider("codex").session(sent.sessionId).createOptions as {
      readOnly?: boolean;
      mode?: string;
      reviewerSession?: boolean;
      interaction?: { interactionPolicy?: unknown };
      policy?: unknown;
    };
    expect(created.readOnly).toBe(true);
    expect(created.mode).toBe("plan");
    expect(created.reviewerSession).toBe(true);
    expect(created.interaction?.interactionPolicy).toEqual(UNATTENDED_AGENT_INTERACTION_POLICY);
    expect(created.policy).toBeDefined();
  });

  test("each row names how strongly read-only holds on that agent", async () => {
    const w = await world();
    const started = handle(
      await w.ask({ targets: [{ agent: "claude" }, { agent: "grok" }], prompt: "Look." }),
    );
    const tier = (agent: string) => started.suborks.find((s) => s.agent === agent)?.readOnly;
    expect(tier("claude")).toBe("enforced");
    expect(tier("grok")).toBe("advisory");
  });
});

describe("/subork ask opus 5.5 and grok 4.7 to rate this code change out of 10", () => {
  test("two suborks run in parallel and the caller gets both, labelled, together", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const w = await world({
      script: (agent) => async (turn, tools) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return answering(() => `${agent} rates it 9`)(agent)(turn, tools, w.provider(agent));
      },
    });
    const started = handle(
      await w.ask({
        targets: [{ model: "opus 5.5" }, { model: "grok 4.7" }],
        prompt: "Rate the change on this branch out of 10.",
      }),
    );
    expect(started.suborks.map((s) => [s.agent, s.model])).toEqual([
      ["claude", "opus"],
      ["cursor", "grok-4.7"],
    ]);
    for (let pass = 0; pass < 10 && peak < 2; pass += 1) {
      await w.service.advanceNow(started.batchId);
      await Bun.sleep(1);
    }
    expect(peak).toBe(2);
    // Nothing is delivered while one is still running.
    release.shift()!();
    await w.service.advanceNow(started.batchId);
    expect(await w.mail()).toHaveLength(0);
    release.shift()!();
    await w.settleProviders();
    await w.drive(started.batchId);

    const mail = await w.mail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("Subork answers: 2 of 2 finished");
    expect(mail[0]!.body).toContain("Claude Code · Opus");
    expect(mail[0]!.body).toContain("claude rates it 9");
    expect(mail[0]!.body).toContain("Cursor Agent · Grok 4.7");
    expect(mail[0]!.body).toContain("cursor rates it 9");
  });

  test("a target's own prompt replaces the shared one", async () => {
    const w = await world();
    const started = handle(
      await w.ask({
        targets: [{ agent: "codex", prompt: "Only for Codex." }, { agent: "claude" }],
        prompt: "Shared.",
      }),
    );
    await w.drive(started.batchId);
    expect(w.provider("codex").turns()[0]!.prompt).toContain("Only for Codex.");
    expect(w.provider("codex").turns()[0]!.prompt).not.toContain("Shared.");
    expect(w.provider("claude").turns()[0]!.prompt).toContain("Shared.");
  });
});

describe("one target failing", () => {
  test("unknown, ambiguous and disabled targets fail alone and the others run", async () => {
    const w = await world({ enabled: ["claude", "codex", "cursor"] });
    const started = handle(
      await w.ask({
        targets: [{ model: "gemini 9" }, { model: "grok 4" }, { agent: "pi" }, { agent: "codex" }],
        prompt: "Look.",
      }),
    );
    expect(started.suborks[0]).toMatchObject({ status: "failed" });
    expect(started.suborks[0]!.error).toContain("No enabled model matches");
    expect(started.suborks[1]!.error).toContain("several models");
    expect(started.suborks[1]!.error).toContain("grok-4.7");
    expect(started.suborks[2]!.error).toContain("turned off in settings");
    expect(started.suborks[3]).toMatchObject({ agent: "codex", status: "starting" });
    await w.drive(started.batchId);
    expect(w.provider("cursor").turns()).toHaveLength(0);
    const [mail] = await w.mail();
    expect(mail!.subject).toBe("Subork answers: 1 of 4 finished");
    expect(mail!.body).toContain("codex says hi");
    expect(mail!.body).toContain("No enabled model matches");
  });

  test("a session that fails resolves as failed, and the caller still gets the others", async () => {
    const w = await world({
      script: (agent) => (agent === "codex" ? async () => "error" : answering()(agent)),
    });
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }, { agent: "claude" }], prompt: "Look." }),
    );
    await w.drive(started.batchId);
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.suborks.map((s) => s.status)).toEqual(["failed", "finished"]);
    expect(view.suborks[0]!.line).toContain("session failed");
    const [mail] = await w.mail();
    expect(mail!.body).toContain("session failed");
    expect(mail!.body).toContain("claude says hi");
  });

  test("a subork still running at the deadline resolves as failed", async () => {
    let now = Date.now();
    const w = await world({
      script: (agent) =>
        agent === "codex" ? () => new Promise<"idle">(() => {}) : answering()(agent),
      service: { now: () => now, deadlineMs: 60_000 },
    });
    w.provider("codex").runningPolls = 1_000_000;
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }, { agent: "claude" }], prompt: "Look." }),
    );
    await w.service.advanceNow(started.batchId);
    await w.service.advanceNow(started.batchId);
    await w.provider("claude").settle();
    await w.service.advanceNow(started.batchId);
    now += 3_600_000;
    await w.service.advanceNow(started.batchId);
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.status).toBe("settled");
    expect(view.suborks[0]).toMatchObject({ status: "failed" });
    expect(view.suborks[0]!.line).toContain("did not finish within 1 minutes");
    expect((await w.mail())[0]!.body).toContain("claude says hi");
    expect(w.provider("codex").sessions.values().next().value!.aborted).toBeGreaterThan(0);
  });

  test("a turn that answered in prose past the reminder has still answered", async () => {
    const w = await world({
      script: () => async () => "idle",
      messages: () => [
        { role: "assistant", parts: [{ type: "text", content: "A prose answer." }] },
      ],
      service: { pollIntervalMs: 0 },
    });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId, 60);
    expect(w.provider("codex").turns().length).toBe(2);
    expect((await w.mail())[0]!.body).toContain("A prose answer.");
  });

  test("a call with nothing to run reports it in the tool result, and no mail follows", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ model: "gemini 9" }], prompt: "Look." }));
    expect(started.next).toContain("No message will follow");
    expect(w.service.views(SESSION_KEY)![0]).toMatchObject({
      status: "settled",
      delivery: "not-needed",
    });
    expect(await w.mail()).toHaveLength(0);
  });

  test("a provider the result-tool rollout excludes fails alone with a clear message", async () => {
    const w = await world({ rolloutAllows: (agent) => agent !== "codex" });
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }, { agent: "claude" }], prompt: "Look." }),
    );
    expect(started.suborks[0]!.error).toContain("Result tools are turned off for Codex");
    expect(started.suborks[1]!.status).toBe("starting");
  });
});

describe("depth and limits", () => {
  test("a subork that reaches for the tool gets a clear refusal", async () => {
    let refusal: Record<string, unknown> | undefined;
    let listed: string[] = [];
    const w = await world({
      script: (agent) => async (turn, tools, provider) => {
        listed = await tools.list();
        refusal = await tools.call(SUBORK_TOOL_NAME, {
          targets: [{ agent: "claude" }],
          prompt: "Go deeper.",
        });
        return answering()(agent)(turn, tools, provider);
      },
    });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    expect(listed).toContain(SUBORK_TOOL_NAME);
    expect(refusal!.isError).toBe(true);
    expect(JSON.stringify(refusal!.content)).toContain("Suborks can't start suborks");
    // Nothing nested started.
    expect(w.provider("claude").turns()).toHaveLength(0);
    expect(w.service.views(SESSION_KEY)).toHaveLength(1);
  });

  test("targets past the per-call limit fail on their own", async () => {
    const w = await world();
    const targets = Array.from({ length: SUBORK_LIMITS.targetsPerCall + 2 }, () => ({
      agent: "codex",
    }));
    const started = handle(await w.ask({ targets, prompt: "Look." }));
    const statuses = started.suborks.map((s) => s.status);
    expect(statuses.filter((status) => status === "starting")).toHaveLength(
      SUBORK_LIMITS.targetsPerCall,
    );
    expect(started.suborks.at(-1)!.error).toContain(`at most ${SUBORK_LIMITS.targetsPerCall}`);
  });

  test("the running limit holds across calls", async () => {
    const w = await world({ script: () => () => new Promise<"idle">(() => {}) });
    const targets = Array.from({ length: SUBORK_LIMITS.targetsPerCall }, () => ({
      agent: "codex",
    }));
    await w.ask({ targets, prompt: "Look." });
    await w.ask({ targets, prompt: "Look." });
    const third = handle(await w.ask({ targets, prompt: "Look." }));
    expect(third.suborks[0]!.error).toContain("already has");
  });

  test("the session's total is a limit, and it outlives retention", async () => {
    const w = await world();
    let last: Handle | undefined;
    const calls = Math.ceil(SUBORK_LIMITS.totalPerSession / SUBORK_LIMITS.targetsPerCall);
    for (let call = 0; call < calls; call += 1) {
      last = handle(
        await w.ask({
          targets: Array.from({ length: SUBORK_LIMITS.targetsPerCall }, () => ({ agent: "codex" })),
          prompt: "Look.",
        }),
      );
      await w.drive(last.batchId);
    }
    expect(w.service.views(SESSION_KEY)!.length).toBeLessThanOrEqual(
      SUBORK_LIMITS.retainedBatchesPerSession,
    );
    await w.restart();
    const refused = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    expect(refused.suborks[0]!.error).toContain(`used its ${SUBORK_LIMITS.totalPerSession}`);
  });

  test("an oversized prompt is refused, and a long response is cut with the cut marked", async () => {
    const huge = "x".repeat(200 * 1024);
    const w = await world({ script: answering(() => huge) });
    const refused = handle(
      await w.ask({
        targets: [{ agent: "codex", prompt: "y".repeat(SUBORK_LIMITS.promptMaxBytes + 1) }],
      }),
    );
    expect(refused.suborks[0]!.error).toContain("larger than");
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }, { agent: "claude" }], prompt: "Look." }),
    );
    await w.drive(started.batchId);
    const [mail] = await w.mail();
    expect(Buffer.byteLength(mail!.body, "utf8")).toBeLessThanOrEqual(AGENT_MAIL_MAX_BODY_BYTES);
    expect(mail!.body).toContain("[Truncated by Orkestrator:");
    expect(mail!.body).toContain(`of ${200 * 1024} bytes kept`);
  });

  test("repeating a requestId is the same call", async () => {
    const w = await world();
    const args = { targets: [{ agent: "codex" }], prompt: "Look.", requestId: "again" };
    const first = handle(await w.ask(args));
    const second = handle(await w.ask(args));
    expect(second.batchId).toBe(first.batchId);
    expect(w.service.views(SESSION_KEY)).toHaveLength(1);
  });
});

describe("stopping and lifecycle", () => {
  test("Stop fences both an admission awaiting the catalogue and queued admissions", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<never[]>();
    const w = await world({
      service: {
        modelCatalog: () => {
          entered.resolve();
          return release.promise;
        },
      },
    });
    const caller = {
      environmentId: "e1",
      projectId: "p1",
      tabId: "agent",
      agent: "claude" as const,
    };
    const input = { targets: [{ agent: "codex" }], prompt: "Look." };
    const first = w.service.ask(caller, input).catch((error) => error);
    await entered.promise;
    const queued = w.service.ask(caller, input).catch((error) => error);
    await w.service.stopForSession(SESSION_KEY);
    release.resolve([]);
    expect(await first).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(w.service.views(SESSION_KEY)).toBeUndefined();
    expect(w.provider("codex").turns()).toHaveLength(0);
    expect(await w.mail()).toHaveLength(0);
  });

  for (const transient of [false, true]) {
    test(`Stop fences waiting delivery (transient failure: ${transient})`, async () => {
      const w = await world();
      const send = w.storage.sendAgentMail.bind(w.storage);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let attempts = 0;
      w.storage.sendAgentMail = async (...args) => {
        attempts++;
        if (transient) throw new Error("temporary mail failure");
        entered.resolve();
        await release.promise;
        return send(...args);
      };
      const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
      if (transient) {
        for (let i = 0; i < 15 && attempts === 0; i++) {
          await w.service.advanceNow(started.batchId);
          await w.settleProviders();
        }
        expect(attempts).toBe(1);
      } else {
        const driving = w.drive(started.batchId);
        await entered.promise;
        await w.service.stopForSession(SESSION_KEY);
        release.resolve();
        await driving;
      }
      await w.service.stopForSession(SESSION_KEY);
      const before = attempts;
      w.storage.sendAgentMail = send;
      await w.service.advanceNow(started.batchId);
      await w.restart();
      await w.service.advanceNow(started.batchId);
      expect(attempts).toBe(before);
      expect(await w.mail()).toHaveLength(0);
      expect(w.service.views(SESSION_KEY)![0]!.delivery).toBe("not-needed");
    });
  }

  test("stopping the caller aborts running suborks and sends no mail", async () => {
    const w = await world({ script: () => () => new Promise<"idle">(() => {}) });
    w.provider("codex").runningPolls = 1_000_000;
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.service.advanceNow(started.batchId);
    await w.service.advanceNow(started.batchId);
    expect(w.provider("codex").turns()).toHaveLength(1);
    await w.service.stopForSession(SESSION_KEY);
    const session = [...w.provider("codex").sessions.values()][0]!;
    expect(session.aborted).toBeGreaterThan(0);
    expect(w.service.views(SESSION_KEY)![0]).toMatchObject({
      status: "stopped",
      delivery: "not-needed",
    });
    expect(w.service.views(SESSION_KEY)![0]!.suborks[0]!.status).toBe("stopped");
    await w.service.advanceNow(started.batchId);
    expect(await w.mail()).toHaveLength(0);
    // A later process does not resume what a person stopped.
    await w.restart();
    await w.service.advanceNow(started.batchId);
    expect(w.provider("codex").turns()).toHaveLength(1);
  });

  test("a Stop during a pass fences it, and the turn it just started is aborted", async () => {
    const w = await world({ script: () => () => new Promise<"idle">(() => {}) });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    w.provider("codex").beforeSend = async () => {
      await w.service.stopForSession(SESSION_KEY);
    };
    await w.service.advanceNow(started.batchId);
    expect(w.service.views(SESSION_KEY)![0]!.status).toBe("stopped");
    const session = [...w.provider("codex").sessions.values()][0];
    if (session) expect(session.aborted).toBeGreaterThan(0);
  });

  test("a late mail publication cannot be claimed after Stop or restart", async () => {
    const w = await world();
    const send = w.storage.sendAgentMail.bind(w.storage);
    const published = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    w.storage.sendAgentMail = async (...args) => {
      const message = await send(...args);
      published.resolve();
      await release.promise;
      return message;
    };
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    const driving = w.drive(started.batchId);
    await published.promise;
    const pending = (await w.storage.listPendingAgentMailInjects())[0]!;
    expect(pending).toBeDefined();
    await w.service.stopForSession(SESSION_KEY);
    expect(
      await w.storage.beginAgentMailInject(
        pending.mailbox.mailboxId,
        pending.message.id,
        pending.mailbox.incarnationId,
      ),
    ).toBeNull();
    release.resolve();
    await driving;
    await w.restart();
    expect((await w.mail())[0]!.placement).toBe("expired");
    expect(w.service.views(SESSION_KEY)![0]!.delivery).toBe("not-needed");
  });

  test("Stop withdraws answers that have not reached the caller yet", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    expect((await w.mail())[0]!.placement).toBe("pending-inject");
    await w.service.stopForSession(SESSION_KEY);
    expect((await w.mail())[0]!.placement).toBe("expired");
    expect(w.service.views(SESSION_KEY)![0]!.delivery).toBe("not-needed");
  });

  test("a caller that is gone stops its suborks", async () => {
    const w = await world({
      script: () => () => new Promise<"idle">(() => {}),
      service: { now: () => 1_000_000 },
    });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.restart();
    w.service.sweep();
    for (let wait = 0; wait < 50; wait += 1) {
      if (w.storage.suborks.getSuborkBatch(started.batchId)?.status === "stopped") break;
      await Bun.sleep(5);
    }
    expect(w.storage.suborks.getSuborkBatch(started.batchId)?.status).toBe("stopped");
  });

  test("a subork running across a backend restart still delivers", async () => {
    let block = true;
    const w = await world({
      script: (agent) => async (turn, tools, provider) => {
        while (block) await Bun.sleep(1);
        return answering()(agent)(turn, tools, provider);
      },
    });
    const started = handle(
      await w.ask({ targets: [{ agent: "codex" }, { agent: "claude" }], prompt: "Look." }),
    );
    await w.service.advanceNow(started.batchId);
    await w.service.advanceNow(started.batchId);
    expect(w.provider("codex").turns()).toHaveLength(1);

    await w.restart();
    expect(w.service.views(SESSION_KEY)![0]!.status).toBe("running");
    block = false;
    await w.settleProviders();
    await w.drive(started.batchId);

    // The same turn finished: nothing was started a second time.
    expect(w.provider("codex").turns()).toHaveLength(1);
    expect(w.provider("codex").duplicateDeliveries).toBe(0);
    const mail = await w.mail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body).toContain("codex says hi");
  });

  test("a crash between settling and sending sends the mail once", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    const delivered = (await w.mail())[0]!;
    w.storage.suborks.updateSuborkBatch(started.batchId, (batch) => ({
      ...batch,
      delivery: "waiting",
    }));
    await w.restart();
    await w.drive(started.batchId);
    const mail = await w.mail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.id).toBe(delivered.id);
  });

  test("a reload reads the same rows from the store", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    const before = w.service.views(SESSION_KEY);
    await w.restart();
    expect(w.service.views(SESSION_KEY)).toEqual(before);
  });

  test("token usage is metered on the row and recorded to the usage history", async () => {
    const w = await world({
      contextUsage: () => ({
        usedTokens: 120,
        sessionTokens: 900,
        turns: [{ turnId: "t1", inputTokens: 100, outputTokens: 20, modelId: "gpt-6.1-sol" }],
      }),
    });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    expect(w.service.views(SESSION_KEY)![0]!.suborks[0]!.tokens).toBe(900);
    expect(w.storage.getAgentUsageHistory({ days: 1 }).totals.inputTokens).toBe(100);
  });

  test("a container environment reaches its tools the way a container turn does", async () => {
    const w = await world({ environmentType: "container" });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    expect(w.reachabilityChecks).toEqual(["e1:Subork"]);
    expect(w.connectionTargets).toEqual(["container"]);
    expect((await w.mail())[0]!.body).toContain("codex says hi");
  });
});

describe("the transcript", () => {
  test("rows show the latest action and a finished one the start of its response", async () => {
    let hold = true;
    const w = await world({
      script: (agent) => async (turn, tools, provider) => {
        while (hold) await Bun.sleep(1);
        return answering(() => "I would ship it.\nEverything passed.")(agent)(
          turn,
          tools,
          provider,
        );
      },
      messages: () => [
        {
          role: "assistant",
          parts: [{ type: "tool", toolName: "Read", toolArgs: { file_path: "src/app.ts" } }],
        },
      ],
    });
    w.provider("codex").runningPolls = 2;
    const started = handle(
      await w.ask({ targets: [{ agent: "codex", name: "Sol review" }], prompt: "Look." }),
    );
    expect(w.service.views(SESSION_KEY)![0]!.suborks[0]).toMatchObject({
      name: "Sol review",
      status: "starting",
    });
    await w.service.advanceNow(started.batchId);
    await w.service.advanceNow(started.batchId);
    expect(w.service.views(SESSION_KEY)![0]!.suborks[0]).toMatchObject({
      status: "running",
      line: "Read: src/app.ts",
    });
    hold = false;
    await w.settleProviders();
    await w.drive(started.batchId);
    const row = w.service.views(SESSION_KEY)![0]!.suborks[0]!;
    expect(row.status).toBe("finished");
    expect(row.line).toBe("I would ship it. Everything passed.");
    expect(w.announced.length).toBeGreaterThan(0);
  });

  test("the command pages beyond 4 MiB to reach the final answer", async () => {
    const stored = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant",
        content: "x".repeat(900_000),
      })),
      { id: "answer", role: "assistant", content: "Final answer" },
    ];
    const w = await world({ messages: () => stored });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    const row = w.service.views(SESSION_KEY)![0]!.suborks[0]!;
    const command = createCommandRegistry().get("native_agent_subork_transcript")!;
    const context = { suborks: w.service } as unknown as CommandContext;
    const input = { environmentId: "e1", batchId: started.batchId, suborkId: row.id };
    const first = (await command(input, context)) as {
      messages: unknown[];
      startIndex: number;
      truncated: boolean;
    };
    expect(first.truncated).toBe(true);
    expect(first.messages.length).toBeGreaterThan(0);
    const next = (await command({ ...input, fromIndex: first.messages.length }, context)) as {
      messages: unknown[];
      startIndex: number;
    };
    expect(next.startIndex).toBe(first.messages.length);
    expect(next.messages.at(-1)).toEqual(stored.at(-1));
    await expect(command({ ...input, fromIndex: -1 }, context)).rejects.toThrow("fromIndex");
  });

  test("a subork's transcript can be read from its row, without touching the provider", async () => {
    const stored = [
      { id: "m1", role: "user", content: "Look.", parts: [{ type: "text", content: "Look." }] },
      {
        id: "m2",
        role: "assistant",
        content: "Looking.",
        parts: [{ type: "text", content: "Looking." }],
      },
    ];
    const w = await world({ messages: () => stored });
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    const row = w.service.views(SESSION_KEY)![0]!.suborks[0]!;
    expect(row.transcriptRevision).toBeGreaterThan(0);
    const read = await w.service.readTranscript({
      environmentId: "e1",
      batchId: started.batchId,
      suborkId: row.id,
    });
    expect(read.status).toBe("found");
    expect((read as { messages: unknown[] }).messages).toEqual(stored);
    // Another environment cannot read it.
    expect(
      (
        await w.service.readTranscript({
          environmentId: "e2",
          batchId: started.batchId,
          suborkId: row.id,
        })
      ).status,
    ).toBe("missing");
  });

  test("a call is removed with its transcripts at environment deletion", async () => {
    const w = await world();
    const started = handle(await w.ask({ targets: [{ agent: "codex" }], prompt: "Look." }));
    await w.drive(started.batchId);
    await w.storage.suborks.deleteSuborkBatchesByEnvironment("e1");
    expect(w.storage.suborks.getSuborkBatch(started.batchId)).toBeNull();
  });

  test("the latest action reads the newest thing a transcript says", () => {
    expect(suborkLatestAction([])).toBeUndefined();
    expect(
      suborkLatestAction([{ role: "user", parts: [{ type: "text", content: "Hello" }] }]),
    ).toBeUndefined();
    expect(
      suborkLatestAction([{ role: "assistant", parts: [{ type: "thinking", content: "..." }] }]),
    ).toBe("Thinking");
    expect(
      suborkLatestAction([
        {
          role: "assistant",
          parts: [
            { type: "text", content: "First" },
            { type: "tool", toolName: "Bash", toolArgs: { command: "git status" } },
          ],
        },
      ]),
    ).toBe("Bash: git status");
    expect(
      suborkLatestAction([
        { role: "assistant", parts: [{ type: "text", content: "line one\n\nline two" }] },
      ]),
    ).toBe("line one line two");
  });
});
