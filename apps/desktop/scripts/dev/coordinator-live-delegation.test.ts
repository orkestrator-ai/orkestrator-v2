import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ASYNC_REPORT_MARKER,
  FAMILY_DONE_MARKER,
  FAMILY_PING_COUNT,
  asyncBodies,
  asyncBusyPrompt,
  asyncPollPrompt,
  asyncQueuedPrompt,
  asyncScenarioPrompt,
  asyncWorkerNames,
  carrierCount,
  coordinatorWaitCounts,
  delegationFailures,
  deliveredWhileRunning,
  evaluateAsyncScenario,
  evaluateFamilyScenario,
  familyBodies,
  familyScenarioPrompt,
  familyWorkerNames,
  gateCommand,
  isCarrierText,
  orkestratorToolCalls,
  parseAsyncPollReport,
  transcriptUserTexts,
  type AsyncScenarioInput,
  type DelegationMailMessage,
  type DelegationObservation,
  type DelegationProbe,
  type DelegationRecord,
  type FamilyScenarioInput,
} from "./coordinator-live-delegation.js";

const probe: DelegationProbe = {
  platform: "codex",
  token: "0123456789ab",
  gatePath: "/tmp/coordinator-live-gate-x/report.go",
  finishGatePath: "/tmp/coordinator-live-gate-x/finish.go",
};
const COORDINATOR = "coordinator:ws:conversation";
const REPORTER = "env-reporter";
const SILENT = "env-silent";

function failedChecks(checks: ReturnType<typeof evaluateAsyncScenario>): string[] {
  return checks.filter((item) => !item.passed).map((item) => item.name);
}

describe("delegation prompts", () => {
  test("the async turn launches both workers and ends without waiting", () => {
    const prompt = asyncScenarioPrompt(probe);
    const names = asyncWorkerNames(probe);
    const bodies = asyncBodies(probe);
    expect(prompt).toContain("get_launch_options");
    expect(prompt).toContain(`name "${names.reporter}"`);
    expect(prompt).toContain(`name "${names.silent}"`);
    expect(prompt).toContain(`agent "${probe.platform}"`);
    expect(prompt).toContain(bodies.progress);
    expect(prompt).toContain(bodies.report);
    // The reporter waits for the harness between its progress and its report.
    expect(prompt.indexOf(bodies.progress)).toBeLessThan(prompt.indexOf(probe.gatePath));
    expect(prompt.indexOf(probe.gatePath)).toBeLessThan(prompt.indexOf(bodies.report));
    // ...and again after its report, so the harness decides when its turn ends.
    expect(prompt.indexOf(bodies.report)).toBeLessThan(prompt.indexOf(probe.finishGatePath));
    expect(prompt).toContain("Do not wait, sleep, read messages or check message status");
    expect(asyncQueuedPrompt(probe)).toContain(bodies.queued);
    expect(asyncBusyPrompt(probe, "project-1")).toContain(bodies.busy);
    expect(asyncBusyPrompt(probe, "project-1")).toContain('"project-1"');
  });

  test("the poll turn names its own mailbox and the report line", () => {
    const prompt = asyncPollPrompt({ environmentId: COORDINATOR, tabId: "tab-1" });
    expect(prompt).toContain(`"environmentId":"${COORDINATOR}"`);
    expect(prompt).toContain('"tabId":"tab-1"');
    expect(prompt).toContain("five times");
    expect(prompt).toContain(ASYNC_REPORT_MARKER);
  });

  test("the family turn sets up the busy follow-up and the ping exchange", () => {
    const prompt = familyScenarioPrompt(probe);
    const names = familyWorkerNames(probe);
    const bodies = familyBodies(probe);
    expect(prompt).toContain(`name "${names.one}"`);
    expect(prompt).toContain(`name "${names.two}"`);
    expect(prompt).toContain(bodies.twoFollowUp);
    // The second worker reports only once the harness opens its gate.
    expect(prompt.indexOf(probe.gatePath)).toBeLessThan(prompt.indexOf(bodies.twoReport));
    expect(prompt).toContain(bodies.ping(1));
    expect(prompt).toContain(bodies.ping(FAMILY_PING_COUNT));
    expect(prompt).toContain(FAMILY_DONE_MARKER);
    expect(prompt).toContain("(no toTabId)");
  });

  test("the gate command waits for the file and survives a quote in the path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coordinator gate's-"));
    try {
      const gate = path.join(directory, "report.go");
      const command = gateCommand(gate).slice(1, -1);
      await writeFile(gate, "open\n");
      const result = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
      expect(result.stdout.trim()).toBe("gate-open");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("transcript evidence", () => {
  test("Orkestrator tools are found whatever prefix the provider gives them", () => {
    const calls = [
      "mcp__orkestrator__read_messages",
      "orkestrator__read_messages",
      "orkestrator_read_messages",
      "read_messages",
      "read_messages_extra",
    ].map((name) => ({ name, args: "{}", state: "succeeded" as const }));
    expect(orkestratorToolCalls(calls, "read_messages")).toHaveLength(4);
  });

  test("waits are counted: shell sleeps and polling reads", () => {
    const counts = coordinatorWaitCounts([
      { name: "Bash", args: '{"command":"sleep 30"}', state: "succeeded" },
      { name: "exec_command", args: '{"cmd":"git log; sleep 5"}', state: "succeeded" },
      { name: "Bash", args: '{"command":"echo no-sleep-here"}', state: "succeeded" },
      // Orkestrator tools carry text: a body or a worker prompt that says
      // `sleep` is not the coordinator waiting.
      { name: "send_message", args: '{"body":"sleep 10"}', state: "succeeded" },
      {
        name: "mcp__orkestrator__launch_environment",
        args: '{"prompt":"run for i in 1 2; do sleep 2; done"}',
        state: "succeeded",
      },
      { name: "mcp__orkestrator__list_environments", args: "{}", state: "succeeded" },
      { name: "mcp__orkestrator__get_message_status", args: "{}", state: "succeeded" },
    ]);
    expect(counts).toEqual({
      sleepCalls: 2,
      listEnvironmentsCalls: 1,
      readMessagesCalls: 0,
      getMessageStatusCalls: 1,
    });
  });

  test("user rows are read from content and parts, and carriers are recognised", () => {
    const texts = transcriptUserTexts([
      { role: "user", content: "hello" },
      { role: "assistant", content: "ignored" },
      {
        role: "user",
        parts: [{ type: "text", content: '<orkestrator-peer-message version="1">' }],
      },
    ]);
    expect(texts).toHaveLength(2);
    expect(texts.map(isCarrierText)).toEqual([false, true]);
  });

  test("the poll report is the last marker line", () => {
    expect(parseAsyncPollReport(`x\n${ASYNC_REPORT_MARKER} {"repeatedRead":true}`)).toEqual({
      repeatedRead: true,
    });
    expect(parseAsyncPollReport("nothing")).toMatchObject({ error: expect.any(String) });
    expect(parseAsyncPollReport(`${ASYNC_REPORT_MARKER} {"repeatedRead":"yes"}`)).toMatchObject({
      error: expect.stringContaining("boolean"),
    });
  });
});

// ---------------------------------------------------------------------------
// The async scenario, as a passing run would leave it

const bodies = asyncBodies(probe);
const progress: DelegationMailMessage = {
  id: "mail-progress",
  createdAt: "2026-10-18T00:00:10.000Z",
  from: { kind: "tab", environmentId: REPORTER, tabId: "startup-agent" },
  toEnvironmentId: COORDINATOR,
  toTabId: "tab-1",
  placement: "injected",
  injectRequestId: "carrier-report",
  injectedAt: "2026-10-18T00:01:30.000Z",
  body: bodies.progress,
};
const report: DelegationMailMessage = {
  ...progress,
  id: "mail-report",
  createdAt: "2026-10-18T00:01:00.000Z",
  body: bodies.report,
};
const silentNotice: DelegationMailMessage = {
  id: "mail-notice",
  createdAt: "2026-10-18T00:00:20.000Z",
  from: { kind: "system" },
  toEnvironmentId: COORDINATOR,
  toTabId: "tab-1",
  placement: "injected",
  injectRequestId: "carrier-notice",
  injectedAt: "2026-10-18T00:00:21.000Z",
  notice: { resource: { environmentId: SILENT }, state: "completed" },
};
const running = (environmentId: string): DelegationRecord => ({
  environmentId,
  requestedAt: "2026-10-18T00:00:00.000Z",
  workerTabId: "startup-agent",
  state: "running",
});
const completed = (environmentId: string, wakeKind: string): DelegationRecord => ({
  ...running(environmentId),
  state: "completed",
  wakeKind,
  wokenAt: "2026-10-18T00:01:30.000Z",
});
const held = (message: DelegationMailMessage): DelegationMailMessage => {
  const { injectRequestId: _carrier, injectedAt: _at, body: _body, ...rest } = message;
  return { ...rest, placement: "inject-held", placementReason: "delegation-running" };
};
const at = (iso: string) => Date.parse(iso);

function passingAsync(): AsyncScenarioInput {
  const observations: DelegationObservation[] = [
    // The delegating turn.
    {
      at: at("2026-10-18T00:00:01Z"),
      coordinatorPhase: "running",
      queueLength: 0,
      delegations: [],
      mail: [],
    },
    {
      at: at("2026-10-18T00:00:05Z"),
      coordinatorPhase: "idle",
      queueLength: 0,
      delegations: [running(REPORTER), running(SILENT)],
      mail: [],
    },
    // The silent worker's notice, and the progress message held.
    {
      at: at("2026-10-18T00:00:40Z"),
      coordinatorPhase: "idle",
      queueLength: 0,
      delegations: [running(REPORTER), completed(SILENT, "notice")],
      mail: [held(progress), silentNotice],
    },
    // Busy, queued, gate open; the reporter finished and its report waits.
    {
      at: at("2026-10-18T00:01:10Z"),
      coordinatorPhase: "running",
      queueLength: 1,
      delegations: [
        { ...completed(REPORTER, "report"), wokenAt: undefined },
        completed(SILENT, "notice"),
      ],
      mail: [
        { ...held(progress), placement: "pending-inject" },
        { ...held(report), placement: "pending-inject" },
        silentNotice,
      ],
    },
    // The queued prompt left the queue before the report was injected.
    {
      at: at("2026-10-18T00:01:20Z"),
      coordinatorPhase: "running",
      queueLength: 0,
      delegations: [
        { ...completed(REPORTER, "report"), wokenAt: undefined },
        completed(SILENT, "notice"),
      ],
      mail: [
        { ...held(progress), placement: "pending-inject" },
        { ...held(report), placement: "pending-inject" },
        silentNotice,
      ],
    },
  ];
  return {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    workers: {
      reporter: { role: "reporter", environmentId: REPORTER },
      silent: { role: "silent", environmentId: SILENT },
    },
    delegatingTurnPhases: ["idle", "running", "running", "idle", "idle"],
    delegatingTurnEndedAt: observations[1]!.at,
    delegatingTurnCalls: [
      { name: "mcp__orkestrator__get_launch_options", args: "{}", state: "succeeded" },
      { name: "mcp__orkestrator__launch_environment", args: "{}", state: "succeeded" },
      { name: "mcp__orkestrator__launch_environment", args: "{}", state: "succeeded" },
    ],
    launchResults: ['{"environmentId":"a","delivery":"async"}', '{\\"delivery\\":\\"async\\"}'],
    queuedAccepted: true,
    messages: [
      { role: "user", content: "the delegating prompt" },
      { role: "user", content: `<orkestrator-peer-message> ${silentNotice.id}` },
      { role: "user", content: "the busy prompt" },
      { role: "user", content: asyncQueuedPrompt(probe) },
      { role: "user", content: `<orkestrator-peer-message> ${progress.id} ${report.id}` },
    ],
    mail: [progress, report, silentNotice],
    observations,
    delegations: [completed(REPORTER, "report"), completed(SILENT, "notice")],
    pollCalls: Array.from({ length: 5 }, () => ({
      name: "read_messages",
      args: '{"environmentId":"coordinator","tabId":"tab-1"}',
      state: "succeeded" as const,
    })),
    pollResults: ["{}", "{}", "{}", '{"messages":[],"repeatedRead":true}', "{}"],
    pollReport: { repeatedRead: true },
    escapedInteractions: [],
    workerInteractions: [],
  };
}

describe("async scenario", () => {
  test("a run that held every contract passes every check", () => {
    const checks = evaluateAsyncScenario(passingAsync());
    expect(delegationFailures(checks)).toEqual([]);
    expect(checks.map((item) => item.name)).toEqual([
      "running-then-idle",
      "launch-async",
      "no-wait-in-turn",
      "queued-before-mail",
      "held-then-one-carrier",
      "silent-worker-one-notice",
      "one-wake-per-delegation",
      "repeated-read-guard",
      "no-user-action",
    ]);
  });

  test("a turn that waited, or ended after the worker, fails no-wait-in-turn", () => {
    const input = passingAsync();
    expect(
      failedChecks(
        evaluateAsyncScenario({
          ...input,
          delegatingTurnCalls: [
            ...input.delegatingTurnCalls,
            { name: "Bash", args: '{"command":"sleep 20"}', state: "succeeded" },
          ],
        }),
      ),
    ).toEqual(["no-wait-in-turn"]);
    const lateIdle = input.observations.map((observation, index) =>
      index === 1 ? { ...observation, delegations: [completed(REPORTER, "report")] } : observation,
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, observations: lateIdle }))).toContain(
      "no-wait-in-turn",
    );
  });

  test("a launch result without delivery async fails", () => {
    const input = passingAsync();
    expect(
      failedChecks(evaluateAsyncScenario({ ...input, launchResults: ['{"status":"accepted"}'] })),
    ).toEqual(["launch-async"]);
  });

  test("the queue check needs the overlap, and the prompt ahead of the report", () => {
    const input = passingAsync();
    // The report was never pending while the coordinator was busy with a prompt queued.
    const noOverlap = input.observations.filter((observation) => observation.queueLength === 0);
    expect(failedChecks(evaluateAsyncScenario({ ...input, observations: noOverlap }))).toContain(
      "queued-before-mail",
    );
    // The report's carrier ran first.
    const swapped = [...input.messages];
    [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
    expect(failedChecks(evaluateAsyncScenario({ ...input, messages: swapped }))).toEqual([
      "queued-before-mail",
    ]);
    // An earlier carrier (the silent worker's notice) does not count against it.
    expect(failedChecks(evaluateAsyncScenario(input))).toEqual([]);
    // Without echoed carriers, the store's timestamps decide.
    const noCarrierRows = input.messages.filter(
      (message) => !isCarrierText(String(message.content)),
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, messages: noCarrierRows }))).toEqual([
      "held-then-one-carrier",
      "one-wake-per-delegation",
    ]);
    const earlyInjection = {
      ...input,
      messages: noCarrierRows,
      mail: [
        { ...progress, injectedAt: "2026-10-18T00:01:15.000Z" },
        { ...report, injectedAt: "2026-10-18T00:01:15.000Z" },
        silentNotice,
      ],
    };
    expect(failedChecks(evaluateAsyncScenario(earlyInjection))).toEqual([
      "queued-before-mail",
      "held-then-one-carrier",
      "one-wake-per-delegation",
    ]);
  });

  test("two carriers, a leak while running, or a reporter notice fail the hold", () => {
    const input = passingAsync();
    // The progress message woke the coordinator on its own, before the report.
    const split = [
      ...input.messages.slice(0, 4),
      { role: "user", content: `<orkestrator-peer-message> ${progress.id}` },
      { role: "user", content: `<orkestrator-peer-message> ${report.id}` },
    ];
    expect(failedChecks(evaluateAsyncScenario({ ...input, messages: split }))).toEqual([
      "held-then-one-carrier",
      "one-wake-per-delegation",
    ]);
    const leaked = input.observations.map((observation, index) =>
      index === 2 ? { ...observation, mail: [progress, silentNotice] } : observation,
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, observations: leaked }))).toContain(
      "held-then-one-carrier",
    );
    const reporterNotice: DelegationMailMessage = {
      ...silentNotice,
      id: "mail-reporter-notice",
      notice: { resource: { environmentId: REPORTER } },
    };
    expect(
      failedChecks(evaluateAsyncScenario({ ...input, mail: [...input.mail, reporterNotice] })),
    ).toEqual(["held-then-one-carrier", "one-wake-per-delegation"]);
  });

  test("carrier count is unverified without complete echoed rows", () => {
    const rows = [`<orkestrator-peer-message> ${progress.id} ${report.id}`];
    expect(carrierCount([progress, report], rows)).toBe(1);
    expect(carrierCount([progress, report], [])).toBeNull();
    expect(
      carrierCount([progress, { ...report, injectedAt: "2026-10-18T00:02:30.000Z" }], []),
    ).toBeNull();
    // Mail not yet delivered was carried by nothing.
    expect(carrierCount([{ ...progress, placement: "pending-inject" }], rows)).toBe(0);
  });

  test("a silent worker needs exactly one notice", () => {
    const input = passingAsync();
    expect(
      failedChecks(
        evaluateAsyncScenario({
          ...input,
          mail: [...input.mail, { ...silentNotice, id: "mail-notice-2", injectRequestId: "c2" }],
        }),
      ),
    ).toEqual(["silent-worker-one-notice", "one-wake-per-delegation"]);
  });

  test("the guard must answer the fourth or fifth identical read", () => {
    const input = passingAsync();
    expect(
      failedChecks(evaluateAsyncScenario({ ...input, pollResults: ["{}", "{}", "{}"] })),
    ).toEqual(["repeated-read-guard"]);
    expect(
      failedChecks(
        evaluateAsyncScenario({
          ...input,
          pollResults: ['{"repeatedRead":true}', "{}", "{}", "{}"],
        }),
      ),
    ).toEqual(["repeated-read-guard"]);
  });

  test("nearby unechoed deliveries cannot certify a single carrier", () => {
    const input = passingAsync();
    const mail = input.mail.map((message) =>
      message.id === report.id
        ? {
            ...message,
            injectRequestId: "distinct-dispatch",
            injectedAt: "2026-10-18T00:01:34.000Z",
          }
        : message,
    );
    const messages = input.messages.filter(
      (message) => !String(message.content).includes("<orkestrator-peer-message"),
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, mail, messages }))).toContain(
      "held-then-one-carrier",
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, mail, messages }))).toContain(
      "one-wake-per-delegation",
    );
    expect(carrierCount(mail, [])).toBeNull();
  });

  test("false flags, error mentions and changed read arguments cannot qualify", () => {
    const input = passingAsync();
    for (const result of [
      '{"repeatedRead":false}',
      "error: repeatedRead",
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ repeatedRead: true }) }],
      }),
    ]) {
      const pollResults = ["{}", "{}", "{}", result, "{}"];
      expect(failedChecks(evaluateAsyncScenario({ ...input, pollResults }))).toEqual([
        "repeated-read-guard",
      ]);
    }
    const pollCalls = input.pollCalls.map((call, index) =>
      index === 2 ? { ...call, args: '{"tabId":"different"}' } : call,
    );
    expect(failedChecks(evaluateAsyncScenario({ ...input, pollCalls }))).toEqual([
      "repeated-read-guard",
    ]);
    const envelope = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ repeatedRead: true }) }],
    });
    expect(
      failedChecks(
        evaluateAsyncScenario({ ...input, pollResults: ["{}", "{}", "{}", envelope, "{}"] }),
      ),
    ).toEqual([]);
    // Key order is immaterial; the parsed arguments must agree.
    expect(
      failedChecks(
        evaluateAsyncScenario({
          ...input,
          pollCalls: input.pollCalls.map((call, index) =>
            index === 1
              ? { ...call, args: '{"tabId":"tab-1","environmentId":"coordinator"}' }
              : call,
          ),
        }),
      ),
    ).toEqual([]);
  });

  test("an approval from a worker is a user action", () => {
    const input = passingAsync();
    expect(
      failedChecks(evaluateAsyncScenario({ ...input, workerInteractions: ["command-approval"] })),
    ).toEqual(["no-user-action"]);
  });

  test("a missing worker fails without throwing", () => {
    const input = passingAsync();
    const checks = evaluateAsyncScenario({ ...input, workers: {}, mail: [], delegations: [] });
    expect(failedChecks(checks)).toContain("launch-async");
    expect(failedChecks(checks)).toContain("silent-worker-one-notice");
  });

  test("held mail delivered while its delegation runs is counted once per message", () => {
    const observation: DelegationObservation = {
      at: 1,
      coordinatorPhase: "idle",
      queueLength: 0,
      delegations: [running(REPORTER)],
      mail: [progress, report, silentNotice],
    };
    expect(deliveredWhileRunning([observation, observation], REPORTER, COORDINATOR)).toBe(2);
    expect(
      deliveredWhileRunning(
        [{ ...observation, delegations: [completed(REPORTER, "report")] }],
        REPORTER,
        COORDINATOR,
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The family scenario, as a passing run would leave it

const ONE = "env-one";
const TWO = "env-two";
const family = familyBodies(probe);

function familyMessage(
  id: string,
  from: DelegationMailMessage["from"],
  to: string,
  body: string,
  carrier: string,
): DelegationMailMessage {
  return {
    id,
    createdAt: new Date(
      Date.parse("2026-10-18T00:00:00.000Z") +
        (id.startsWith("ping-")
          ? Number(id.slice(5)) * 2000
          : id.startsWith("pong-")
            ? Number(id.slice(5)) * 2000 + 1000
            : 0),
    ).toISOString(),
    from,
    toEnvironmentId: to,
    toTabId: to === COORDINATOR ? "tab-1" : "startup-agent",
    placement: "injected",
    injectRequestId: carrier,
    body,
  };
}
const fromTab = (environmentId: string) => ({
  kind: "tab",
  environmentId,
  tabId: "startup-agent",
});
const fromCoordinator = { kind: "coordinator", environmentId: COORDINATOR };

function passingFamily(): FamilyScenarioInput {
  const followUp = familyMessage(
    "follow-up",
    fromCoordinator,
    TWO,
    `Reply with ${family.twoFollowUp}`,
    "carrier-two-in",
  );
  const mail: DelegationMailMessage[] = [
    familyMessage("one-report", fromTab(ONE), COORDINATOR, family.oneReport, "carrier-one"),
    followUp,
    familyMessage("two-report", fromTab(TWO), COORDINATOR, family.twoReport, "carrier-two"),
    familyMessage("two-reply", fromTab(TWO), COORDINATOR, family.twoFollowUp, "carrier-two"),
  ];
  for (let index = 1; index <= FAMILY_PING_COUNT; index += 1) {
    mail.push(
      familyMessage(
        `ping-${index}`,
        fromCoordinator,
        ONE,
        `Reply with ${family.ping(index)}`,
        `carrier-ping-${index}`,
      ),
      familyMessage(
        `pong-${index}`,
        fromTab(ONE),
        COORDINATOR,
        family.ping(index),
        `carrier-pong-${index}`,
      ),
    );
  }
  const calls = Array.from({ length: FAMILY_PING_COUNT }, () => ({
    name: "mcp__orkestrator__send_message",
    args: JSON.stringify({ toEnvironmentId: ONE, body: "Reply with …" }),
    state: "succeeded" as const,
  }));
  return {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    workers: { one: { role: "one", environmentId: ONE }, two: { role: "two", environmentId: TWO } },
    calls,
    assistantText: `done\n${FAMILY_DONE_MARKER}`,
    userTexts: [
      "the family prompt",
      "<orkestrator-peer-message> one-report",
      "<orkestrator-peer-message> two-report two-reply",
      ...Array.from(
        { length: FAMILY_PING_COUNT },
        (_, index) => `<orkestrator-peer-message> pong-${index + 1}`,
      ),
    ],
    mail,
    observations: [
      {
        at: 1,
        coordinatorPhase: "idle",
        queueLength: 0,
        workerPhases: { [ONE]: "idle", [TWO]: "running" },
        delegations: [running(ONE), running(TWO)],
        mail: [{ ...followUp, placement: "pending-inject" }],
      },
      {
        at: 2,
        coordinatorPhase: "idle",
        queueLength: 0,
        delegations: [completed(ONE, "report"), completed(TWO, "report")],
        mail,
      },
    ],
    escapedInteractions: [],
    workerInteractions: [],
    harnessPrompts: 1,
  };
}

describe("family scenario", () => {
  test("a run with every message delivered unattended passes every check", () => {
    const checks = evaluateFamilyScenario(passingFamily());
    expect(delegationFailures(checks)).toEqual([]);
    expect(checks.map((item) => item.name)).toEqual([
      "both-workers-launched",
      "both-workers-report",
      "busy-follow-up-joins-delegation",
      "follow-up-by-environment-id",
      "ten-more-alternating",
      "no-stored-or-failed",
      "no-user-action",
    ]);
  });

  test("a stored or failed placement anywhere in the family fails", () => {
    const input = passingFamily();
    for (const placement of ["stored", "inject_failed"]) {
      const mail = input.mail.map((message) =>
        message.id === "pong-3" ? { ...message, placement } : message,
      );
      expect(failedChecks(evaluateFamilyScenario({ ...input, mail }))).toEqual([
        "ten-more-alternating",
        "no-stored-or-failed",
      ]);
    }
  });

  test("a follow-up that opened its own wake fails the join", () => {
    const input = passingFamily();
    const userTexts = input.userTexts.flatMap((text) =>
      text.includes("two-reply")
        ? ["<orkestrator-peer-message> two-report", "<orkestrator-peer-message> two-reply"]
        : [text],
    );
    expect(failedChecks(evaluateFamilyScenario({ ...input, userTexts }))).toEqual([
      "busy-follow-up-joins-delegation",
    ]);
  });

  test("a follow-up sent after the worker's delegation closed does not count as busy", () => {
    const input = passingFamily();
    const observations = input.observations.map((observation) => ({
      ...observation,
      delegations: observation.delegations.map((delegation) =>
        delegation.environmentId === TWO ? completed(TWO, "report") : delegation,
      ),
    }));
    expect(failedChecks(evaluateFamilyScenario({ ...input, observations }))).toEqual([
      "busy-follow-up-joins-delegation",
    ]);
  });

  test("a follow-up delivered before the worker's turn ran is not the busy case", () => {
    const input = passingFamily();
    const observations = input.observations.map((observation) => ({
      ...observation,
      workerPhases: { [ONE]: "idle", [TWO]: "idle" },
    }));
    const checks = evaluateFamilyScenario({ ...input, observations });
    expect(failedChecks(checks)).toEqual(["busy-follow-up-joins-delegation"]);
    expect(
      checks.find((item) => item.name === "busy-follow-up-joins-delegation")?.detail,
    ).toContain("pending-inject while idle");
  });

  test("batched requests and a single reply containing all tokens fail alternation", () => {
    const input = passingFamily();
    const batched = input.mail.map((message) => ({
      ...message,
      createdAt: message.id.startsWith("ping-") ? "2026-10-18T00:00:01.000Z" : message.createdAt,
    }));
    expect(failedChecks(evaluateFamilyScenario({ ...input, mail: batched }))).toContain(
      "ten-more-alternating",
    );
    const oneReply = input.mail
      .filter((message) => !message.id.startsWith("pong-") || message.id === "pong-6")
      .map((message) =>
        message.id === "pong-6"
          ? {
              ...message,
              body: Array.from({ length: FAMILY_PING_COUNT }, (_, i) => family.ping(i + 1)).join(
                " ",
              ),
            }
          : message,
      );
    expect(failedChecks(evaluateFamilyScenario({ ...input, mail: oneReply }))).toContain(
      "ten-more-alternating",
    );
    const sameTime = input.mail.map((message) => ({
      ...message,
      createdAt: "2026-10-18T00:00:00.000Z",
    }));
    expect(failedChecks(evaluateFamilyScenario({ ...input, mail: sameTime }))).toContain(
      "ten-more-alternating",
    );
  });

  test("a short exchange, a tab-addressed follow-up or a second prompt fail", () => {
    const input = passingFamily();
    const short = input.mail.filter((message) => message.id !== `pong-${FAMILY_PING_COUNT}`);
    expect(failedChecks(evaluateFamilyScenario({ ...input, mail: short }))).toEqual([
      "ten-more-alternating",
    ]);
    const byTab = input.calls.map((call) => ({
      ...call,
      args: JSON.stringify({ toEnvironmentId: ONE, toTabId: "startup-agent" }),
    }));
    expect(failedChecks(evaluateFamilyScenario({ ...input, calls: byTab }))).toEqual([
      "follow-up-by-environment-id",
    ]);
    expect(failedChecks(evaluateFamilyScenario({ ...input, harnessPrompts: 2 }))).toEqual([
      "no-user-action",
    ]);
  });
});
