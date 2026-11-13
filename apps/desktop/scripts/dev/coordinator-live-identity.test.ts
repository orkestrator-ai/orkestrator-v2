import { describe, expect, test } from "bun:test";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  IDENTITY_IDLE_MARKER,
  IDENTITY_REPORT_MARKER,
  IDENTITY_RESUME_MARKER,
  IDENTITY_TABS,
  identityCodeWord,
  identityIdleMail,
  identityResumePrompt,
  identityTabPrompt,
  parseResumeReport,
  selfMailboxes,
} from "./coordinator-live-identity.js";
import { runIdentityScenario } from "./coordinator-live-identity-orchestration.js";
import { runCoordinatorCleanup } from "./coordinator-live-observer.js";

const token = "scripted";
const probe = { platform: "cursor" as const, token };
const ENV = "env-identity";

describe("identity scenario", () => {
  test("only the first tab is given a code word, and every prompt names its report line", () => {
    expect(identityTabPrompt(probe, IDENTITY_TABS.first)).toContain(identityCodeWord(probe));
    expect(identityTabPrompt(probe, IDENTITY_TABS.second)).not.toContain(identityCodeWord(probe));
    expect(identityTabPrompt(probe, IDENTITY_TABS.second)).toContain(IDENTITY_REPORT_MARKER);
    expect(identityResumePrompt()).toContain(IDENTITY_RESUME_MARKER);
    expect(identityResumePrompt()).not.toContain(identityCodeWord(probe));
    expect(identityIdleMail(probe)).toContain(`${IDENTITY_IDLE_MARKER} ${token}`);
  });

  test("self rows are read from the tool's JSON; anything else marks nothing", () => {
    const output = JSON.stringify({
      mailboxes: [
        { environmentId: ENV, tabId: "a", self: true },
        { environmentId: ENV, tabId: "b", self: false },
      ],
    });
    expect(selfMailboxes(output)).toEqual([`${ENV}/a`]);
    expect(selfMailboxes("not json")).toEqual([]);
    expect(selfMailboxes(JSON.stringify({ isError: true }))).toEqual([]);
  });

  test("the resume report: the last line wins", () => {
    expect(parseResumeReport(`${IDENTITY_RESUME_MARKER} {"code":" x "}`)).toEqual({ code: "x" });
    expect(parseResumeReport("nothing")).toMatchObject({ error: expect.any(String) });
  });

  test("its budget covers five tab turns or waits", () => {
    const budgets = coordinatorLiveBudgets({});
    expect(budgets.waits.identity).toBe(budgets.step * 5);
  });
});

// ---------------------------------------------------------------------------
// The orchestration over a scripted command transport

type Script = {
  /** Every tab is handed the first tab's credential. */
  sharedCredential?: boolean;
  /** The tab's `idle` policy is not honoured: user mail is held. */
  ignoresIdlePolicy?: boolean;
  /** The resume opens a new conversation instead of the first one. */
  resumeStartsOver?: boolean;
  /** The resumed tab keeps the first tab's credential. */
  resumeKeepsOldCredential?: boolean;
  /** The provider has no login. */
  signedOut?: boolean;
  /** The second tab's turn asks for an approval. */
  approval?: boolean;
};

const tabOf = (logicalSessionKey: unknown) => String(logicalSessionKey).split(":").at(-1)!;

function fixture(script: Script = {}) {
  const environments: Array<{ id: string; name: string }> = [];
  const transcripts = new Map<string, CoordinatorTranscriptMessage[]>();
  const sessions = new Map<string, string>();
  const working = new Map<string, number>();
  const pending = new Map<string, Array<Record<string, unknown>>>();
  const mail: Array<{ id: string; placement: string }> = [];
  const injects: Array<Record<string, unknown>> = [];
  const resolutions: Array<Record<string, unknown>> = [];
  let created = false;
  let sessionCount = 0;

  const rows = (tab: string) => {
    const list = transcripts.get(tab) ?? [];
    transcripts.set(tab, list);
    return list;
  };
  const listing = (tab: string) => {
    const self = script.sharedCredential
      ? IDENTITY_TABS.first
      : tab === IDENTITY_TABS.resumed && script.resumeKeepsOldCredential
        ? IDENTITY_TABS.first
        : tab;
    return JSON.stringify({
      mailboxes: Object.values(IDENTITY_TABS).map((id) => ({
        environmentId: ENV,
        tabId: id,
        self: id === self,
      })),
    });
  };
  const turn = (tab: string, text: string, withListing = true) => {
    const list = rows(tab);
    if (withListing) {
      list.push({
        role: "assistant",
        parts: [
          {
            toolName: "mcp__orkestrator__list_mailboxes",
            toolArgs: {},
            toolOutput: listing(tab),
            toolState: "completed",
          },
        ],
      });
    }
    list.push({ role: "assistant", content: text });
    working.set(tab, 2);
  };

  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    let value: unknown = null;
    const tab = tabOf(args.logicalSessionKey);
    switch (command) {
      case "get_environments":
        value = [...environments];
        break;
      case "create_environment":
        created = true;
        environments.push({ id: ENV, name: String(args.name) });
        value = { id: ENV };
        break;
      case "start_environment":
      case "save_pane_layout":
      case "stop_environment":
      case "delete_environment":
        break;
      case "get_pane_layout":
        value = null;
        break;
      case "ensure_native_agent_session":
        if (script.signedOut) throw new Error("Cursor isn't signed in");
        sessions.set(tab, `provider-${(sessionCount += 1)}`);
        break;
      case "dispatch_native_agent_intent": {
        const prompt = String(args.prompt);
        rows(tab).push({ role: "user", content: "harness prompt" });
        if (tab === IDENTITY_TABS.resumed) {
          const remembers = !script.resumeStartsOver;
          turn(
            tab,
            `${IDENTITY_RESUME_MARKER} ${JSON.stringify({ self: tab, code: remembers ? identityCodeWord(probe) : "" })}`,
          );
        } else {
          expect(prompt).toContain("list_mailboxes");
          turn(tab, `${IDENTITY_REPORT_MARKER} ${JSON.stringify({ self: tab })}`);
          if (script.approval && tab === IDENTITY_TABS.second) {
            pending.set(tab, [
              {
                id: "approval-1",
                kind: "command-approval",
                state: "pending",
                sessionId: "s",
                createdAt: Date.now(),
              },
            ]);
          }
        }
        break;
      }
      case "resolve_native_agent_interaction":
        resolutions.push(args.resolution as Record<string, unknown>);
        pending.set(tab, []);
        break;
      case "mute_agent_mail":
        injects.push({ tabId: args.tabId, inject: args.inject });
        break;
      case "send_agent_mail": {
        const policy = injects.filter((entry) => entry.tabId === args.toTabId).at(-1)?.inject;
        const injected = policy === "idle" && !script.ignoresIdlePolicy;
        mail.push({ id: "mail-1", placement: injected ? "injected" : "held" });
        if (injected) {
          rows(String(args.toTabId)).push({ role: "user", content: "mail carrier" });
          turn(String(args.toTabId), `${IDENTITY_IDLE_MARKER} ${token}`, false);
        }
        value = { id: "mail-1" };
        break;
      }
      case "get_agent_mail_mailbox":
        value = { messages: mail.map((message) => ({ ...message, from: { kind: "user" } })) };
        break;
      case "resume_native_agent_session":
        rows(tab).push(...(script.resumeStartsOver ? [] : rows(IDENTITY_TABS.first)));
        sessions.set(
          tab,
          script.resumeStartsOver ? "provider-new" : String(args.providerSessionId),
        );
        break;
      case "get_native_agent_session":
        value = sessions.has(tab) ? { providerSessionId: sessions.get(tab) } : null;
        break;
      case "get_native_agent_projection": {
        const remaining = working.get(tab) ?? 0;
        if (remaining > 0) working.set(tab, remaining - 1);
        value = {
          turn: { phase: remaining > 0 ? "working" : "idle" },
          messages: [...rows(tab)],
          interactions: [...(pending.get(tab) ?? [])],
        };
        break;
      }
      case "get_native_agent_tool_details":
        value = null;
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };
  return { invoke, injects, resolutions, created: () => created };
}

async function run(script: Script = {}) {
  const { invoke, injects, resolutions } = fixture(script);
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "cursor",
    scenario: "identity",
    verdict: "failed",
    startedAt: "test",
  };
  const cleanup: Array<() => Promise<unknown>> = [];
  const skip = (reason: string): never => {
    summary.verdict = "skipped";
    summary.reason = reason;
    throw new Error(reason);
  };
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "200";
  try {
    const result = await runIdentityScenario({
      invoke,
      projectId: "project",
      platform: "cursor",
      summary,
      skip,
      cleanup,
      token,
      pollIntervalMs: 1,
    });
    return { ...result, summary, injects, resolutions, error: undefined as unknown };
  } catch (error) {
    return { checks: [], observed: {}, summary, injects, resolutions, error };
  } finally {
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

describe("identity scenario orchestration", () => {
  test("two tabs see themselves, idle mail starts a turn, and a resume keeps the conversation under its own tab", async () => {
    const { checks, observed, injects, error } = await run();
    expect(error).toBeUndefined();
    expect(checks.filter((item) => !item.passed)).toEqual([]);
    expect(observed).toEqual({ listings: 3, idleTurnStarted: 1, sameProviderSession: 1 });
    // The policy is set for the case and put back afterwards.
    expect(injects).toEqual([
      { tabId: IDENTITY_TABS.second, inject: "idle" },
      { tabId: IDENTITY_TABS.second, inject: "inherit" },
    ]);
  });

  test("a tab handed another tab's credential fails on self", async () => {
    const { checks } = await run({ sharedCredential: true });
    expect(failed(checks)).toEqual(expect.arrayContaining(["self-identity-b", "self-identity-c"]));
    expect(failed(checks)).not.toContain("self-identity-a");
  });

  test("mail held despite the idle policy fails both idle checks", async () => {
    const { checks } = await run({ ignoresIdlePolicy: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining(["finished", "idle-mail-injected", "idle-injection-started-a-turn"]),
    );
  });

  test("a resume that starts a new conversation fails", async () => {
    const { checks } = await run({ resumeStartsOver: true });
    expect(failed(checks)).toEqual([
      "resume-same-conversation",
      "resume-remembers-the-conversation",
    ]);
  });

  test("a resumed tab still on the old tab's credential fails", async () => {
    const { checks } = await run({ resumeKeepsOldCredential: true });
    expect(failed(checks)).toEqual(["self-identity-c"]);
  });

  test("an approval in a tab's turn is denied and fails the case", async () => {
    const { checks, resolutions } = await run({ approval: true });
    expect(failed(checks)).toEqual(["no-escaped-interactions"]);
    expect(resolutions).toEqual([expect.objectContaining({ action: "deny" })]);
  });

  test("a signed-out provider is a skip, not a failure", async () => {
    const { summary, error } = await run({ signedOut: true });
    expect(error).toBeInstanceOf(Error);
    expect(summary.verdict).toBe("skipped");
    expect(summary.reason).toContain("no usable cursor credential");
  });
});
