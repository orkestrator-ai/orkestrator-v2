import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionApplyOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import type { NativeAgentPermissionRule } from "@orkestrator/protocol/permission-rules";
import type { PermissionRuleRequestDetail } from "../agent-provider-contract.js";
import type { Environment, PersistedNativeAgentSession } from "../models.js";
import { StorageService } from "../storage.js";
import { PermissionRuleEnforcer, PermissionRuleRefusedError } from "./enforcer.js";
import type { PermissionRuleStore } from "./store.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function openStore(): Promise<PermissionRuleStore> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-permission-enforcer-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return storage.permissionRuleStore();
}

const NOW = 10_000;
const ENVIRONMENT = {
  id: "env-1",
  projectId: "project-1",
  name: "feature",
  environmentType: "local",
  worktreePath: "/work/app",
} as unknown as Environment;

function session(
  overrides: Partial<PersistedNativeAgentSession> = {},
): PersistedNativeAgentSession {
  return {
    version: 1,
    key: "session-key",
    environmentId: "env-1",
    agent: "codex",
    logicalSessionKey: "tab-1",
    providerSessionId: "thread-1",
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    policy: {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as PersistedNativeAgentSession;
}

function rule(overrides: Partial<NativeAgentPermissionRule> = {}): NativeAgentPermissionRule {
  return {
    id: "rule-1",
    provider: "codex",
    scope: "project",
    projectId: "project-1",
    kind: "command-prefix",
    pattern: "npm test",
    createdAt: 1,
    createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i-0" },
    useCount: 0,
    ...overrides,
  };
}

function request(
  id: string,
  overrides: Partial<AgentInteractionRequest> = {},
): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id,
    provider: "codex",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: "thread-1",
    state: "pending",
    revision: 0,
    presentation: {
      title: "Approve command",
      body: "Command: npm test",
      questions: [],
      confirmLabel: "Approve",
      declineLabel: "Deny",
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

/** A provider whose pending list and rule details the test controls. */
class FakeProvider {
  pending: AgentInteractionRequest[] = [];
  details = new Map<string, PermissionRuleRequestDetail>();
  resolutions: AgentInteractionResolution[] = [];
  result: AgentInteractionApplyOutcome["result"] = "applied";

  readonly interactions = {
    listPendingInteractions: async (sessionId: string): Promise<AgentInteractionSnapshot> =>
      ({
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        sessionId,
        revision: 1,
        requests: this.pending,
      }) as unknown as AgentInteractionSnapshot,
    resolveInteraction: async (
      sessionId: string,
      interactionId: string,
      resolution: AgentInteractionResolution,
    ): Promise<AgentInteractionApplyOutcome> => {
      this.resolutions.push(resolution);
      if (this.result === "applied") {
        this.pending = this.pending.filter((entry) => entry.id !== interactionId);
      }
      return { result: this.result, interactionId, sessionId, revision: 2 };
    },
    permissionRuleDetail: (_sessionId: string, interactionId: string) =>
      this.details.get(interactionId) ?? null,
  };

  ask(id: string, command: string, overrides: Partial<AgentInteractionRequest> = {}) {
    this.pending.push(request(id, overrides));
    this.details.set(id, { subject: { kind: "command", command }, allowOnceAnswers: [] });
  }

  snapshot(): AgentInteractionSnapshot {
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      sessionId: "thread-1",
      revision: 1,
      requests: [...this.pending],
    } as unknown as AgentInteractionSnapshot;
  }
}

function enforcer(store: () => PermissionRuleStore, environment: Environment | null = ENVIRONMENT) {
  const applied: string[] = [];
  const instance = new PermissionRuleEnforcer({
    store,
    getEnvironment: async () => environment,
    now: () => NOW,
    onApplied: (application) => applied.push(application.interactionId),
  });
  return { instance, applied };
}

describe("automatic answers", () => {
  test("a matching rule answers allow-once, is recorded and counted, and hides the card", async () => {
    const store = await openStore();
    store.create(rule());
    const provider = new FakeProvider();
    provider.ask("a1", "/bin/zsh -lc 'npm test -- --watch'");
    provider.ask("a2", "npm publish");
    const { instance, applied } = enforcer(() => store);

    const result = await instance.apply(session(), provider, provider.snapshot());

    expect(result.answered).toBe(1);
    expect(result.snapshot.requests.map((entry) => entry.id)).toEqual(["a2"]);
    expect(provider.resolutions).toEqual([
      expect.objectContaining({
        interactionId: "a1",
        action: "answer",
        answer: expect.objectContaining({ answers: [] }),
      }),
    ]);
    expect(applied).toEqual(["a1"]);
    expect(store.get("rule-1")).toMatchObject({ useCount: 1, lastUsedAt: NOW });
    expect(store.listApplications()).toEqual([
      expect.objectContaining({ ruleId: "rule-1", interactionId: "a1", pattern: "npm test" }),
    ]);
    // The unanswered card carries the remember offer instead.
    expect(result.snapshot.requests[0]!.presentation.ruleOffer).toEqual({
      kind: "command-prefix",
      patterns: ["npm publish"],
      suggested: 0,
    });
  });

  test("removing a rule takes effect on the very next request", async () => {
    const store = await openStore();
    store.create(rule());
    const provider = new FakeProvider();
    const { instance } = enforcer(() => store);
    provider.ask("first", "npm test");
    expect((await instance.apply(session(), provider, provider.snapshot())).answered).toBe(1);

    store.delete("rule-1");
    provider.ask("second", "npm test");
    const result = await instance.apply(session(), provider, provider.snapshot());
    expect(result.answered).toBe(0);
    expect(result.snapshot.requests.map((entry) => entry.id)).toEqual(["second"]);
    expect(provider.resolutions).toHaveLength(1);
  });

  test("a request is answered at most once, even when a read raced the first answer", async () => {
    const store = await openStore();
    store.create(rule());
    const provider = new FakeProvider();
    provider.ask("a1", "npm test");
    const { instance } = enforcer(() => store);
    const stale = provider.snapshot();
    await Promise.all([
      instance.apply(session(), provider, stale),
      instance.apply(session(), provider, stale),
    ]);
    await instance.apply(session(), provider, stale);
    expect(provider.resolutions).toHaveLength(1);
  });

  test("a provider that does not apply the answer leaves the card, and it is not retried", async () => {
    const store = await openStore();
    store.create(rule());
    const provider = new FakeProvider();
    provider.result = "provider-unavailable";
    provider.ask("a1", "npm test");
    const { instance, applied } = enforcer(() => store);
    const first = await instance.apply(session(), provider, provider.snapshot());
    expect(first.snapshot.requests.map((entry) => entry.id)).toEqual(["a1"]);
    const second = await instance.apply(session(), provider, provider.snapshot());
    expect(second.snapshot.requests.map((entry) => entry.id)).toEqual(["a1"]);
    expect(provider.resolutions).toHaveLength(1);
    expect(applied).toEqual([]);
    expect(store.get("rule-1")?.useCount).toBe(0);
  });

  test("a Grok approval is answered by selecting its allow-once option", async () => {
    const store = await openStore();
    store.create(rule({ provider: "grok" }));
    const provider = new FakeProvider();
    provider.pending.push(request("g1", { provider: "grok" }));
    provider.details.set("g1", {
      subject: { kind: "command", command: "npm test" },
      allowOnceAnswers: [{ questionId: "decision", optionIds: ["q0o1"] }],
    });
    const { instance } = enforcer(() => store);
    await instance.apply(session({ agent: "grok" }), provider, provider.snapshot());
    expect(provider.resolutions[0]!.answer!.answers).toEqual([
      { questionId: "decision", optionIds: ["q0o1"] },
    ]);
  });
});

describe("failing closed", () => {
  async function unanswered(
    overrides: {
      session?: Partial<PersistedNativeAgentSession>;
      request?: Partial<AgentInteractionRequest>;
      environment?: Environment | null;
      store?: () => PermissionRuleStore;
      rule?: Partial<NativeAgentPermissionRule>;
      detail?: PermissionRuleRequestDetail | null;
    } = {},
  ): Promise<boolean> {
    const store = await openStore();
    store.create(rule(overrides.rule));
    const provider = new FakeProvider();
    provider.ask("a1", "npm test", overrides.request);
    if (overrides.detail !== undefined) {
      if (overrides.detail) provider.details.set("a1", overrides.detail);
      else provider.details.delete("a1");
    }
    const { instance } = enforcer(
      overrides.store ?? (() => store),
      overrides.environment === undefined ? ENVIRONMENT : overrides.environment,
    );
    const result = await instance.apply(session(overrides.session), provider, provider.snapshot());
    return result.answered === 0 && provider.resolutions.length === 0;
  }

  test("a store that cannot be read asks", async () => {
    expect(
      await unanswered({
        store: () => {
          throw new Error("database is locked");
        },
      }),
    ).toBe(true);
  });

  test("rules never widen the session's policy", async () => {
    expect(await unanswered({ session: { origin: "coordinator" } })).toBe(true);
    expect(await unanswered({ session: { origin: "build-pipeline" } })).toBe(true);
    expect(
      await unanswered({ session: { interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY } }),
    ).toBe(true);
    expect(await unanswered({ session: { executionPolicy: "coordinator-read-only" } })).toBe(true);
    expect(
      await unanswered({
        session: { policy: { ...session().policy!, approvals: "deny" } },
      }),
    ).toBe(true);
    expect(
      await unanswered({ session: { policy: { ...session().policy!, id: "pipeline" } } }),
    ).toBe(true);
    expect(await unanswered({ session: { controls: { mode: "plan" } } })).toBe(true);
    expect(
      await unanswered({
        session: {
          policy: { ...session().policy!, capabilityPolicy: { deny: ["shell"] } },
        },
      }),
    ).toBe(true);
    expect(
      await unanswered({
        session: {
          interactionPolicy: {
            ...INTERACTIVE_AGENT_INTERACTION_POLICY,
            kinds: { "command-approval": "deny-and-fail" },
          },
        },
      }),
    ).toBe(true);
  });

  test("a restricted network never auto-approves a host", async () => {
    expect(
      await unanswered({
        session: { policy: { ...session().policy!, networkAccess: "restricted" } },
        rule: { kind: "network-host", pattern: "example.com" },
        detail: { subject: { kind: "network-host", host: "example.com" }, allowOnceAnswers: [] },
      }),
    ).toBe(true);
  });

  test("a request the bridge marked unapprovable, or did not describe exactly, asks", async () => {
    expect(
      await unanswered({
        request: { presentation: { ...request("x").presentation, confirmDisabled: true } },
      }),
    ).toBe(true);
    expect(await unanswered({ detail: null })).toBe(true);
    expect(await unanswered({ request: { expiresAt: NOW } })).toBe(true);
    expect(await unanswered({ request: { kind: "question" } })).toBe(true);
  });

  test("a missing or deleting environment asks", async () => {
    expect(await unanswered({ environment: null })).toBe(true);
    expect(
      await unanswered({
        environment: { ...ENVIRONMENT, deletionRequestedAt: "2026-10-27T00:00:00Z" },
      }),
    ).toBe(true);
  });

  test("another project's or environment's rule, and an expired one, answer nothing", async () => {
    expect(await unanswered({ rule: { projectId: "project-2" } })).toBe(true);
    expect(await unanswered({ rule: { scope: "environment", environmentId: "env-2" } })).toBe(true);
    expect(await unanswered({ rule: { expiresAt: NOW } })).toBe(true);
    expect(await unanswered({ rule: { provider: "claude" } })).toBe(true);
  });
});

describe("the waiting-session sweep", () => {
  test("reads pending requests only when a rule could apply", async () => {
    const store = await openStore();
    const provider = new FakeProvider();
    let reads = 0;
    const list = provider.interactions.listPendingInteractions;
    provider.interactions.listPendingInteractions = async (sessionId) => {
      reads += 1;
      return list(sessionId);
    };
    provider.ask("a1", "npm test");
    const { instance } = enforcer(() => store);
    expect(await instance.applyToWaitingSession(session(), provider)).toBeNull();
    expect(reads).toBe(0);

    store.create(rule());
    expect(await instance.applyToWaitingSession(session(), provider)).toEqual({
      answered: 1,
      remaining: 0,
    });
    expect(reads).toBe(1);
  });
});

describe("approve and remember", () => {
  test("answers allow-once and then saves the chosen offered pattern", async () => {
    const store = await openStore();
    const provider = new FakeProvider();
    provider.ask("a1", "npm run test -- --watch");
    const { instance } = enforcer(() => store);
    const result = await instance.approveAndRemember(session(), provider, "a1", {
      pattern: "npm run test",
      scope: "environment",
      anyProvider: false,
      expiresInMs: 7 * 24 * 60 * 60 * 1_000,
    });
    expect(result.outcome.result).toBe("applied");
    expect(result.rule).toMatchObject({
      provider: "codex",
      scope: "environment",
      environmentId: "env-1",
      projectId: "project-1",
      kind: "command-prefix",
      pattern: "npm run test",
      expiresAt: NOW + 7 * 24 * 60 * 60 * 1_000,
      createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "a1" },
    });
    expect(store.list()).toHaveLength(1);
  });

  test("refuses a pattern the backend did not offer, an odd expiry, or an ineligible session", async () => {
    const store = await openStore();
    const provider = new FakeProvider();
    provider.ask("a1", "npm test");
    const { instance } = enforcer(() => store);
    for (const pattern of ["npm", "npm test; id", "sudo npm", "npm publish"]) {
      await expect(
        instance.approveAndRemember(session(), provider, "a1", {
          pattern,
          scope: "project",
          anyProvider: false,
        }),
      ).rejects.toBeInstanceOf(PermissionRuleRefusedError);
    }
    await expect(
      instance.approveAndRemember(session(), provider, "a1", {
        pattern: "npm test",
        scope: "project",
        anyProvider: false,
        expiresInMs: 1,
      }),
    ).rejects.toBeInstanceOf(PermissionRuleRefusedError);
    await expect(
      instance.approveAndRemember(session({ origin: "coordinator" }), provider, "a1", {
        pattern: "npm test",
        scope: "project",
        anyProvider: false,
      }),
    ).rejects.toBeInstanceOf(PermissionRuleRefusedError);
    expect(provider.resolutions).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test("saves nothing when the request is gone or the answer was not applied", async () => {
    const store = await openStore();
    const provider = new FakeProvider();
    const { instance } = enforcer(() => store);
    const gone = await instance.approveAndRemember(session(), provider, "missing", {
      pattern: "npm test",
      scope: "project",
      anyProvider: false,
    });
    expect(gone.outcome.result).toBe("stale");
    provider.ask("a1", "npm test");
    provider.result = "rejected";
    const rejected = await instance.approveAndRemember(session(), provider, "a1", {
      pattern: "npm test",
      scope: "project",
      anyProvider: true,
    });
    expect(rejected.rule).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
