import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import {
  accountSwitchApplies,
  accountSwitchInstruction,
  accountSwitchPrompt,
  limitedEnvironments,
  listsAccount,
  scheduleOutcome,
  switchOutcome,
  type AccountSwitchProbe,
} from "./coordinator-live-account-switch.js";
import {
  runAccountSwitchScenario,
  type SeededTurnOutcome,
} from "./coordinator-live-account-switch-orchestration.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";

const token = "scripted";
const WORKER = "worker-env";
const FIXTURE = "acct-fixture";
const probe: AccountSwitchProbe = {
  platform: "claude",
  token,
  accountId: FIXTURE,
  workerEnvironmentId: WORKER,
  at: "+1m",
};

describe("account-switch scenario", () => {
  test("only Claude and Codex have accounts to switch", () => {
    expect(AGENT_PLATFORMS.filter((platform) => accountSwitchApplies(platform).applies)).toEqual([
      "claude",
      "codex",
    ]);
  });

  test("only the granted phase asks for the user's permission, and only it passes the scheduleId", () => {
    const request = accountSwitchPrompt(probe, "request");
    const granted = accountSwitchPrompt(probe, "granted");
    expect(request).toContain("no authorizeAccountSwitch field");
    expect(request).toContain("no scheduleId");
    expect(request).toContain('at "+1m"');
    expect(granted).toContain(`"platforms":["claude"]`);
    expect(granted).toContain(JSON.stringify(accountSwitchInstruction(probe)));
    expect(granted).toContain("the scheduleId the reminder names");
    for (const prompt of [request, granted]) {
      expect(prompt).toContain("get_usage_limits");
      expect(prompt).toContain("list_provider_accounts");
      expect(prompt).toContain(`fixture-${token}`);
    }
  });

  test("tool results are read from their JSON", () => {
    expect(
      scheduleOutcome(JSON.stringify({ scheduleId: "s1", carriesAccountSwitchPermission: true })),
    ).toEqual({ scheduleId: "s1", carriesPermission: true });
    expect(scheduleOutcome("not json")).toEqual({ scheduleId: null, carriesPermission: false });
    expect(
      limitedEnvironments(JSON.stringify({ limitedTabs: [{ environmentId: WORKER }, {}] })),
    ).toEqual([WORKER]);
    expect(
      listsAccount(
        JSON.stringify({ providers: { claude: { accounts: [{ accountId: FIXTURE }] } } }),
        FIXTURE,
      ),
    ).toBe(true);
    expect(listsAccount(JSON.stringify({ providers: {} }), FIXTURE)).toBe(false);
    expect(switchOutcome(JSON.stringify({ state: "pending", accountId: FIXTURE }))).toMatchObject({
      state: "pending",
      accountId: FIXTURE,
    });
  });

  test("its budget covers both phases", () => {
    const budgets = coordinatorLiveBudgets({});
    expect(budgets.waits["account-switch"]).toBe(budgets.step * 8);
  });
});

// ---------------------------------------------------------------------------
// The orchestration over a scripted command transport

type Script = {
  /** The granted phase's timer is set without the user's permission. */
  forgetsPermission?: boolean;
  /** The coordinator switches in the set turn, before the timer fires. */
  switchesEarly?: boolean;
  /** The woken coordinator never reads the usage limits. */
  skipsLimits?: boolean;
  /** The backend switches at once without a permission (the bug this guards). */
  switchesWithoutPermission?: boolean;
  /** The timer never fires. */
  timerNeverFires?: boolean;
  /** A person answers the held request in the dialog, with this decision. */
  personDecides?: "reject" | "approve";
};

const tool = (toolName: string, output: unknown): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [
    {
      toolName: `mcp__orkestrator__${toolName}`,
      toolArgs: {},
      toolOutput: JSON.stringify(output),
      toolState: "completed",
    },
  ],
});

function fixture(script: Script = {}, asked: () => boolean = () => true) {
  const now = () => new Date().toISOString();
  const environments: Array<{ id: string; name: string }> = [];
  const messages: CoordinatorTranscriptMessage[] = [];
  const mail: DelegationMailMessage[] = [];
  const turns: Array<{ turnId: string }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const seeded: SeededTurnOutcome[] = [];
  const staged: string[] = [];
  const deleted: string[] = [];
  let active = "default";
  let working = 0;
  let workerReads = 0;
  let schedules = 0;
  /** Projection reads until the pending timer fires, and its phase. */
  let timer: { reads: number; phase: "request" | "granted"; scheduleId: string } | undefined;

  const wake = (rows: CoordinatorTranscriptMessage[]) => {
    working = 2;
    turns.push({ turnId: `turn-${turns.length}` });
    messages.push({ role: "user", content: "mail carrier" }, ...rows);
  };
  const switchRows = (phase: "request" | "granted", scheduleId: string) => {
    const grantedHere = phase === "granted" && !script.forgetsPermission;
    let output: Record<string, unknown>;
    if (grantedHere || script.switchesWithoutPermission) {
      active = FIXTURE;
      requests.push({
        requestId: `switch-${requests.length}`,
        kind: "switch-agent-account",
        state: "executed",
        targets: [{ nodeId: "self", platform: "claude", accountId: FIXTURE }],
        ...(grantedHere
          ? { authorizedBy: "self-timer", selfTimer: { scheduleId } }
          : { authorizedBy: "standing-grant" }),
      });
      output = { state: "switched", accountId: FIXTURE, previousAccountId: "default" };
    } else {
      const requestId = `switch-${requests.length}`;
      requests.push({
        requestId,
        kind: "switch-agent-account",
        state: "pending",
        targets: [{ nodeId: "self", platform: "claude", accountId: FIXTURE }],
      });
      output = { state: "pending", accountId: FIXTURE, approvalRequestId: requestId };
    }
    return tool("switch_provider_account", output);
  };
  const wakeRows = (phase: "request" | "granted", scheduleId: string) => [
    ...(script.skipsLimits
      ? []
      : [tool("get_usage_limits", { limitedTabs: [{ environmentId: WORKER }] })]),
    tool("list_provider_accounts", {
      providers: { claude: { accounts: [{ accountId: "default" }, { accountId: FIXTURE }] } },
    }),
    ...(script.switchesEarly ? [] : [switchRows(phase, scheduleId)]),
    { role: "assistant", content: "Switch handled." } as CoordinatorTranscriptMessage,
  ];

  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    let value: unknown = null;
    switch (command) {
      case "get_environments":
        value = [...environments];
        break;
      case "create_environment":
        environments.push({ id: WORKER, name: String(args.name) });
        value = { id: WORKER };
        break;
      case "start_environment":
      case "stop_environment":
      case "delete_environment":
        break;
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_project_coordinator":
        value = { workflows: [] };
        break;
      case "list_agent_accounts":
        value = { accounts: [], active: { claude: active } };
        break;
      case "list_node_action_requests":
        // The person answers the dialog once the harness has asked them to.
        if (script.personDecides && asked()) {
          const pending = requests.find((request) => request.state === "pending");
          if (pending && (pending.seen = Number(pending.seen ?? 0) + 1) > 2) {
            pending.state = script.personDecides === "reject" ? "rejected" : "executed";
            if (script.personDecides === "approve") active = FIXTURE;
            wake([{ role: "assistant", content: "Noted." }]);
          }
        }
        value = requests.map(({ seen: _seen, ...request }) => ({ ...request }));
        break;
      case "resolve_node_action_request": {
        const request = requests.find((item) => item.requestId === args.requestId);
        if (request) request.state = args.decision === "reject" ? "rejected" : "executed";
        mail.push({
          id: `outcome-${mail.length}`,
          createdAt: now(),
          from: { kind: "node" },
          toEnvironmentId: "coordinator",
          toTabId: "coord-tab",
          placement: "injected",
        });
        wake([{ role: "assistant", content: "Noted." }]);
        break;
      }
      case "delete_scheduled_job":
        deleted.push(String(args.scheduleId));
        break;
      case "dispatch_native_agent_intent": {
        const prompt = String(args.prompt);
        const phase = prompt.includes("authorizeAccountSwitch {") ? "granted" : "request";
        const scheduleId = `schedule-${(schedules += 1)}`;
        messages.push({ role: "user", content: "harness prompt" });
        messages.push(
          tool("create_schedule", {
            scheduleId,
            carriesAccountSwitchPermission: phase === "granted" && !script.forgetsPermission,
          }),
        );
        if (script.switchesEarly) messages.push(switchRows(phase, scheduleId));
        messages.push({ role: "assistant", content: "Timer set." });
        turns.push({ turnId: `turn-${turns.length}` });
        working = 2;
        if (!script.timerNeverFires) timer = { reads: 6, phase, scheduleId };
        break;
      }
      case "get_agent_mail_mailbox":
        value = {
          messages:
            args.environmentId === "coordinator"
              ? mail.map(({ body: _body, ...rest }) => ({ ...rest }))
              : [],
        };
        break;
      case "get_agent_mail_message":
        value = { body: "private" };
        break;
      case "get_native_agent_tool_details":
        value = null;
        break;
      case "get_native_agent_projection":
        if (args.environmentId === "coordinator") {
          if (working === 0 && timer && (timer.reads -= 1) <= 0) {
            const fired = timer;
            timer = undefined;
            mail.push({
              id: `reminder-${fired.scheduleId}`,
              createdAt: now(),
              from: { kind: "system" },
              toEnvironmentId: "coordinator",
              toTabId: "coord-tab",
              placement: "injected",
            });
            wake(wakeRows(fired.phase, fired.scheduleId));
          }
          const phase = working > 0 ? "working" : "idle";
          if (working > 0) working -= 1;
          value = { turn: { phase }, messages: [...messages], contextUsage: { turns: [...turns] } };
        } else {
          workerReads += 1;
          value = {
            turn: { phase: workerReads <= 2 ? "working" : "idle" },
            messages: workerReads > 1 ? [{ role: "assistant", content: "ready" }] : [],
          };
        }
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };
  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { environmentId: "coordinator", agent: "claude", logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const fixtures = {
    async stageAccount(platform: string, label: string) {
      staged.push(`${platform}:${label}`);
      return { accountId: FIXTURE };
    },
    async seedTurnOutcome(identity: DelegationCoordinator["identity"], outcome: SeededTurnOutcome) {
      expect(identity.environmentId).toBe(WORKER);
      seeded.push(outcome);
    },
  };
  return { coordinator, fixtures, seeded, staged, deleted, requests, active: () => active };
}

async function run(script: Script = {}) {
  const logged: string[] = [];
  const scripted = fixture(script, () =>
    logged.some((line) => line.includes("approval dialog now")),
  );
  const log = console.log;
  console.log = (line: unknown) => void logged.push(String(line));
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "claude",
    verdict: "passed",
    startedAt: "test",
  };
  const cleanup: Array<() => Promise<unknown>> = [];
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "300";
  try {
    const result = await runAccountSwitchScenario({
      coordinator: scripted.coordinator,
      summary,
      cleanup,
      fixtures: scripted.fixtures,
      token,
      pollIntervalMs: 1,
      ...(script.personDecides ? { holdRequestForPerson: true } : {}),
    });
    return { ...result, ...scripted, summary, logged };
  } finally {
    console.log = log;
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

describe("account-switch scenario orchestration", () => {
  test("a request the user rejects, then a switch under a granted timer, qualifies", async () => {
    const result = await run();
    expect(result.checks.filter((item) => !item.passed)).toEqual([]);
    // The seeded failure is a usage limit, on the harness-made worker.
    expect(result.seeded).toEqual([
      expect.objectContaining({ outcome: "failed", failureKind: "usage-limit" }),
    ]);
    expect(result.staged).toEqual([`claude:fixture-${token}`]);
    // One rejected request, then one switch the timer's permission ran.
    expect(result.requests.map((request) => [request.state, request.authorizedBy])).toEqual([
      ["rejected", undefined],
      ["executed", "self-timer"],
    ]);
    expect(result.active()).toBe(FIXTURE);
    // Both timers are deleted on the way out.
    expect(result.deleted.toSorted()).toEqual(["schedule-1", "schedule-2"]);
  });

  test("a granted-phase timer set without the user's permission fails", async () => {
    const { checks } = await run({ forgetsPermission: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining([
        "finished",
        "granted:timer-permission",
        "granted:switched-under-the-timer",
        "granted:recorded-as-the-timers",
      ]),
    );
    expect(failed(checks).some((name) => name.startsWith("request:"))).toBe(false);
  });

  test("a switch before the timer fires fails", async () => {
    const { checks } = await run({ switchesEarly: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining(["request:nothing-before-the-timer", "request:one-switch-call"]),
    );
  });

  test("a coordinator that never reads the usage limits fails", async () => {
    const { checks } = await run({ skipsLimits: true });
    expect(failed(checks)).toEqual(["request:limits-read", "granted:limits-read"]);
  });

  test("a switch that ran without anyone's permission fails the request phase", async () => {
    const { checks } = await run({ switchesWithoutPermission: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining([
        "finished",
        "request:switch-requested",
        "request:request-filed",
        "request:rejected-switches-nothing",
      ]),
    );
  });

  test("held for a person, a request rejected in the dialog qualifies, and the harness sends no answer", async () => {
    const { checks, requests, logged } = await run({ personDecides: "reject" });
    expect(checks.filter((item) => !item.passed)).toEqual([]);
    expect(requests[0]).toMatchObject({ state: "rejected" });
    expect(logged.some((line) => line.includes("approval dialog"))).toBe(true);
  });

  test("held for a person, a request approved in the dialog fails: it changed the account", async () => {
    const { checks } = await run({ personDecides: "approve" });
    expect(failed(checks)).toEqual(expect.arrayContaining(["request:rejected-switches-nothing"]));
  });

  test("a timer that never fires is reported, not hung on", async () => {
    const { checks } = await run({ timerNeverFires: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining([
        "finished",
        "request:reminder-delivered",
        "request:woken-by-the-timer",
        "granted:ran",
      ]),
    );
  });
});
