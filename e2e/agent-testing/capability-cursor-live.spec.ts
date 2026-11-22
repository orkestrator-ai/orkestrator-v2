/**
 * Live Cursor SDK conformance for capability delivery
 * (docs/todo/cross-cutting/8314-agent-capabilities-follow-ups.md, task 1;
 * docs/architecture/agent-capabilities-management.md, "Qualification").
 *
 * The Cursor SDK has no credential-free listing: it discovers skills only
 * inside an authenticated run. So against a running agent-test profile this
 * spec:
 *
 * 1. authors a skill whose name carries a fresh nonce and adds it to My setup
 *    for Cursor alone, through the backend's own capability commands, so the
 *    capability executor writes it (into the profile's isolated HOME;
 *    `agentTestCapabilityHomes`);
 * 2. starts a Cursor session in a fixture environment and asks, with tools
 *    forbidden, for the names of its skills with the nonce's prefix. The
 *    nonce is never in the prompt, so a reply naming it proves the pinned SDK
 *    put the delivered skill in the run's skill list. A turn that used any
 *    tool is inconclusive and fails;
 * 3. removes it from the setup through the same commands, checks the files
 *    are gone, and asks a fresh session the same question, which must not
 *    name it.
 *
 * Two billed turns. Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_CAPABILITIES=1`);
 * the profile must authorize Cursor's login (`--credential-source cursor`).
 * `--agent-platforms cursor` keeps the plan to Cursor's own directory, but the
 * spec excludes every other provider either way. A missing login skips.
 *
 * Writes `output/agent-testing/<run>/capability-cursor-live/cursor.json`
 * (names, locations, statuses and tool rows; no prompt or reply text beyond
 * whether the nonce appeared).
 */
import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { dispatchProbeTurn, invokeCommand } from "./mcp-apply-live-support";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_CAPABILITIES === "1";
const MODEL = process.env.ORKESTRATOR_AGENT_TEST_CAPABILITY_MODEL?.trim() || undefined;
const TURN_TIMEOUT_MS = 240_000;
const OTHER_PROVIDERS = ["claude", "codex", "grok", "opencode", "pi"] as const;
const PREFIX = "ork-cq-";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  dataDir?: string;
  browserUrl?: string;
  testProject?: string;
};
type Message = { id: string; role: string; content?: unknown; parts?: unknown };
type Interaction = { id: string; sessionId: string; kind: string; state: string };
type Projection = {
  turn: { phase: string; error?: string };
  messages: Message[];
  interactions?: Interaction[];
};
type Target = {
  key: string;
  target: { provider?: string; nodeId?: string };
  componentId: string;
  action: string;
  locationId?: string;
  alsoVisibleTo?: string[];
  status: string;
  reason?: string;
};
type Operation = {
  id: string;
  state: string;
  planDigest: string;
  targets: Target[];
  error?: string;
};

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for "${profile}" returned no manifest: ${command.stderr.trim()}`);
  }
  return JSON.parse(command.stdout) as Status;
}

async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = await invokeCommand(
      command,
      () =>
        page.request.post(new URL("/__orkestrator/invoke", status.browserUrl!).href, {
          data: { command, args },
          timeout: TURN_TIMEOUT_MS,
        }),
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    );
    if (!answer.ok()) throw new Error(`${command}: ${(await answer.text()).slice(0, 1_000)}`);
    return ((await answer.json()) as { result: T }).result;
  };
}

function textOf(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

/** Tool parts of a turn's rows: type, tool name and state only. */
function toolRows(messages: readonly Message[]): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (typeof part?.type !== "string" || !/tool|mcp/i.test(part.type)) continue;
      const name = [part.toolName, part.tool, part.name].find((value) => typeof value === "string");
      rows.push(`${part.type}:${String(name ?? "?")}`.slice(0, 120));
    }
  }
  return rows;
}

function signedOut(value: unknown): boolean {
  return /sign(ed)? ?(in|out)|not authenticated|unauthori[sz]ed|needs? auth|log ?in|expired|api key/i.test(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
}

const TERMINAL = new Set(["completed", "partially-completed", "failed", "cancelled", "superseded"]);

/** Preview, approve exactly the previewed plan, and wait for the operation to settle. */
async function applyChange(call: Invoke, change: Record<string, unknown>): Promise<Operation> {
  const preview = await call<{ operation: Operation }>("preview_capability_change", { change });
  await call("apply_capability_change", {
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
    requestKey: randomUUID(),
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const operation = await call<Operation>("get_capability_operation", {
      operationId: preview.operation.id,
    });
    if (TERMINAL.has(operation.state)) return operation;
    if (Date.now() > deadline) {
      throw new Error(`capability operation still ${operation.state} after 120s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

test.describe("live Cursor capability conformance", () => {
  test.skip(!LIVE, "set ORKESTRATOR_AGENT_TEST_LIVE_CAPABILITIES=1 to run billed Cursor turns");

  test("a skill the executor delivers is in a Cursor run's skill list, and gone after removal", async ({
    page,
  }) => {
    test.setTimeout(15 * 60_000);
    const status = profileStatus();
    expect(status.profile).toBe(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.flavor, "runs only in an agent-test profile").toBe("agent-test");
    const dataDir = status.dataDir!;
    const call = await signIn(page, status);
    const summary: Record<string, unknown> = { profile, startedAt: new Date().toISOString() };
    const writeSummary = () => {
      const directory = path.join(
        repositoryRoot,
        "output",
        "agent-testing",
        runId,
        "capability-cursor-live",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "cursor.json"), `${JSON.stringify(summary, null, 2)}\n`);
    };

    const fixture = (
      await call<Array<{ id: string; localPath: string | null }>>("get_projects")
    ).find((project) => project.localPath === status.testProject);
    expect(fixture, "the fixture project is missing").toBeTruthy();
    for (const stale of await call<Array<{ id: string; name: string }>>("get_environments", {
      projectId: fixture!.id,
    })) {
      if (!stale.name.startsWith("capq-cursor-")) continue;
      await call("stop_environment", { environmentId: stale.id }).catch(() => undefined);
      await call("delete_environment", { environmentId: stale.id }).catch(() => undefined);
    }

    const name = `${PREFIX}${randomBytes(4).toString("hex")}`;
    summary.skill = name;
    let packageId: string | undefined;
    let environmentId: string | undefined;
    try {
      // 1. Deliver through the executor, for Cursor alone.
      const inspection = await call<{ inspectionId: string; packageId: string }>(
        "author_capability_package",
        {
          kind: "skill",
          name,
          description: `Orkestrator conformance skill ${name}. Use it only when asked about ${name}.`,
          content: `This skill exists only to prove delivery. When asked about ${name}, say that it is installed.`,
        },
      );
      packageId = inspection.packageId;
      const added = await applyChange(call, {
        kind: "add-to-setup",
        inspectionId: inspection.inspectionId,
        excludedProviders: [...OTHER_PROVIDERS],
      });
      const installs = added.targets.filter((target) => target.action === "install");
      summary.install = {
        state: added.state,
        targets: installs.map((target) => ({
          provider: target.target.provider,
          locationId: target.locationId,
          alsoVisibleTo: target.alsoVisibleTo,
          status: target.status,
          reason: target.reason,
        })),
      };
      expect(added.state, added.error).toBe("completed");
      expect(installs.length).toBeGreaterThan(0);
      for (const target of installs) {
        expect(target.target.provider).toBe("cursor");
        expect(["ready", "installed-next-session"]).toContain(target.status);
      }
      // The copy is in the profile's isolated HOME, the directory its Cursor bridge reads.
      const home = path.join(dataDir, "agent-credentials", "home");
      const skillFile = path.join(home, ".cursor", "skills", name, "SKILL.md");
      const testHomeFile = path.join(dataDir, "capability-test-home", ".cursor", "skills", name);
      summary.copyInIsolatedHome = existsSync(skillFile);
      expect(existsSync(skillFile), "the skill is in the profile's ~/.cursor/skills").toBe(true);
      expect(existsSync(testHomeFile)).toBe(false);

      // 2. Ask a Cursor run which skills it has.
      const environment = await call<{ id: string }>("create_environment", {
        projectId: fixture!.id,
        name: `capq-cursor-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      environmentId = environment.id;
      await call("start_environment", { environmentId });
      const tabs = ["capq-cursor-present", "capq-cursor-removed"];
      const layout = await call<{ revision?: number } | null>("get_pane_layout", {
        environmentId,
      });
      await call("save_pane_layout", {
        environmentId,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-capq",
          root: {
            kind: "leaf",
            id: "pane-capq",
            activeTabId: tabs[0],
            tabs: tabs.map((id, index) => ({
              id,
              type: "agent-native",
              displayTitle: `Cursor capability ${index === 0 ? "present" : "removed"}`,
              nativeAgentData: { environmentId, platform: "cursor", isLocal: true },
              ...(MODEL ? { initialAgentModel: MODEL } : {}),
            })),
          },
        },
      });
      const identity = (tab: string) => ({
        environmentId,
        agent: "cursor",
        logicalSessionKey: `env-${environmentId}:${tab}`,
      });
      const prompt = [
        `Look only at the list of agent skills available to you in this session.`,
        `Reply with the exact name of every skill whose name starts with "${PREFIX}", one per line, and nothing else.`,
        `If there is none, reply with exactly NONE.`,
        `Do not use any tools.`,
      ].join(" ");

      const ask = async (tab: string) => {
        try {
          await call("ensure_native_agent_session", {
            ...identity(tab),
            ...(MODEL ? { model: MODEL } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          test.skip(signedOut(message), `Cursor is not signed in: ${message.slice(0, 200)}`);
          throw error;
        }
        const dispatch = await dispatchProbeTurn(
          (requestId) =>
            call<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
              ...identity(tab),
              prompt,
              requestId,
              mode: "build",
              ...(MODEL ? { model: MODEL } : {}),
            }),
          randomUUID,
          () => new Promise((resolve) => setTimeout(resolve, 5_000)),
        );
        if (dispatch.outcome !== "accepted") {
          throw new Error(`dispatch ${dispatch.outcome}: ${(dispatch.error ?? "").slice(0, 200)}`);
        }
        const deadline = Date.now() + TURN_TIMEOUT_MS;
        const answered = new Set<string>();
        let idleReads = 0;
        for (;;) {
          const current = await call<Projection | null>("get_native_agent_projection", {
            ...identity(tab),
            messageLimit: 50,
          });
          // Any approval is refused: the turn must not run a tool at all.
          for (const request of current?.interactions ?? []) {
            if (request.state !== "pending" || answered.has(request.id)) continue;
            answered.add(request.id);
            await call("resolve_native_agent_interaction", {
              ...identity(tab),
              interactionId: request.id,
              resolution: {
                version: 1,
                interactionId: request.id,
                sessionId: request.sessionId,
                action: "cancel",
                resolvedAt: Date.now(),
              },
            }).catch(() => undefined);
          }
          const messages = current?.messages ?? [];
          const own = messages.findLastIndex(
            (message) => message.role === "user" && textOf(message).includes(PREFIX),
          );
          const fresh = own >= 0 ? messages.slice(own + 1) : [];
          const phase = current?.turn.phase ?? "idle";
          idleReads = phase === "idle" ? idleReads + 1 : 0;
          if (phase === "error") {
            const error = current?.turn.error ?? "turn error";
            test.skip(signedOut(error), `Cursor is not signed in: ${error.slice(0, 200)}`);
            throw new Error(`Cursor turn failed: ${error.slice(0, 300)}`);
          }
          const reply = fresh
            .filter((message) => message.role === "assistant")
            .map(textOf)
            .join("\n");
          if (idleReads >= 2 && reply.trim()) {
            return { reply, tools: toolRows(fresh), approvals: answered.size };
          }
          if (Date.now() > deadline) throw new Error(`no Cursor reply within ${TURN_TIMEOUT_MS}ms`);
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
      };

      const present = await ask(tabs[0]!);
      summary.present = {
        named: present.reply.includes(name),
        none: /^\s*NONE\s*$/.test(present.reply),
        tools: present.tools,
        approvals: present.approvals,
      };
      expect(present.tools, "the turn used a tool, so its answer proves nothing").toEqual([]);
      expect(present.reply, "the Cursor run lists the delivered skill").toContain(name);

      // 3. Remove it through the same commands; a new session no longer has it.
      const removed = await applyChange(call, { kind: "remove-from-setup", packageId });
      packageId = undefined;
      summary.remove = {
        state: removed.state,
        targets: removed.targets
          .filter((target) => target.action === "remove")
          .map((target) => ({ locationId: target.locationId, status: target.status })),
      };
      expect(removed.state, removed.error).toBe("completed");
      expect(existsSync(path.dirname(skillFile)), "the skill directory is removed").toBe(false);

      const absent = await ask(tabs[1]!);
      summary.absent = {
        named: absent.reply.includes(name),
        none: /^\s*NONE\s*$/.test(absent.reply),
        tools: absent.tools,
        approvals: absent.approvals,
      };
      expect(absent.tools).toEqual([]);
      expect(absent.reply, "a session started after removal does not list it").not.toContain(name);
      summary.result = "passed";
    } catch (error) {
      summary.result = "failed";
      summary.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      throw error;
    } finally {
      if (packageId) {
        await applyChange(call, { kind: "remove-from-setup", packageId }).catch(() => undefined);
      }
      if (environmentId) {
        await call("stop_environment", { environmentId }).catch(() => undefined);
        await call("delete_environment", { environmentId }).catch(() => undefined);
      }
      summary.finishedAt = new Date().toISOString();
      writeSummary();
    }
  });
});
