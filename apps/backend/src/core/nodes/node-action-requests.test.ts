import { expect, test } from "bun:test";
import {
  NodeActionRequests,
  parseNodeActionApproval,
  type NodeActionRequest,
} from "./node-action-requests.js";

const input = {
  kind: "delete-environment" as const,
  targets: [{ nodeId: "bk_leaf", nodeName: "Leaf", environmentId: "e" }],
  requestedBy: {
    projectId: "p",
    coordinatorEnvironmentId: "coordinator:c:v",
    coordinatorTabId: "t",
  },
};

test("first-use list and concurrent creates share loading and ordered durable snapshots", async () => {
  let release!: (value: unknown) => void;
  let loads = 0;
  let durable: NodeActionRequest[] = [];
  const old = {
    ...input,
    requestId: "old",
    state: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const actions = new NodeActionRequests({
    load: () => {
      loads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    save: async (requests) => {
      await new Promise((resolve) => setTimeout(resolve, requests.length === 2 ? 10 : 0));
      durable = structuredClone(requests);
    },
    emit: () => undefined,
    executors: {},
  });
  const listed = actions.list();
  const a = actions.create(input);
  const b = actions.create(input);
  release([old]);
  await Promise.all([listed, a, b]);
  expect(loads).toBe(1);
  expect((await actions.list()).map((entry) => entry.requestId)).toHaveLength(3);
  expect(durable.map((entry) => entry.requestId)).toEqual(
    (await actions.list()).map((entry) => entry.requestId),
  );
  expect(durable[0]!.requestId).toBe("old");
});

test("overlapping decisions execute once", async () => {
  let executions = 0;
  const actions = new NodeActionRequests({
    load: async () => [],
    save: async () => {},
    emit: () => {},
    executors: {
      "delete-environment": async () => {
        executions++;
        return { code: "deleted", message: "Deleted" };
      },
    },
  });
  const request = await actions.create(input);
  const results = await Promise.allSettled([
    actions.resolve(request.requestId, "approve"),
    actions.resolve(request.requestId, "approve"),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(executions).toBe(1);
});

test("approval parsing rejects malformed inputs and bounds paths, and trims locations", () => {
  for (const value of [false, 1, "approval", []]) {
    expect(() => parseNodeActionApproval(value)).toThrow("Expected approval");
  }
  for (const paths of ["file", [false], ["a".repeat(1025)], Array(2001).fill("file")]) {
    expect(() => parseNodeActionApproval({ paths })).toThrow("Expected paths");
  }
  expect(() => parseNodeActionApproval({ location: "x".repeat(1025) })).toThrow("location");
  expect(
    parseNodeActionApproval({
      location: "  /srv/site  ",
      paths: [".env", "config/"],
      rememberFiles: true,
      ignored: true,
    }),
  ).toEqual({ location: "/srv/site", paths: [".env", "config/"], rememberFiles: true });
  expect(parseNodeActionApproval(null)).toEqual({});
});

test("stable approval identities survive reload, reject changed payloads, and never reopen settled requests", async () => {
  let durable: NodeActionRequest[] = [];
  let notices = 0;
  const options = {
    load: async () => structuredClone(durable),
    save: async (requests: NodeActionRequest[]) => {
      durable = structuredClone(requests);
    },
    emit: () => {},
    executors: {},
    notify: async () => {
      notices++;
    },
  };
  let actions = new NodeActionRequests(options);
  const request = await actions.create({ ...input, requestId: "stable-approval" });
  actions = new NodeActionRequests(options);
  expect((await actions.create({ ...input, requestId: "stable-approval" })).requestId).toBe(
    request.requestId,
  );
  expect(await actions.list()).toHaveLength(1);
  await expect(
    actions.create({ ...input, requestId: "stable-approval", reason: "changed" }),
  ).rejects.toThrow("different payload");
  await actions.resolve(request.requestId, "reject");
  actions = new NodeActionRequests(options);
  expect(await actions.create({ ...input, requestId: "stable-approval" })).toMatchObject({
    state: "rejected",
  });
  expect(notices).toBe(1);
});

test("unattended runs take the limit and the record together, and never mail", async () => {
  let executions = 0;
  let notices = 0;
  const actions = new NodeActionRequests({
    load: async () => [],
    save: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    emit: () => undefined,
    executors: {
      "switch-agent-account": async () => {
        executions++;
        return { code: "switched", message: "Switched." };
      },
    },
    notify: async () => {
      notices++;
    },
  });
  const run = (requestId: string) =>
    actions.runUnattended(
      {
        requestId,
        kind: "switch-agent-account",
        targets: [{ nodeId: "bk_leaf", nodeName: "Leaf", platform: "claude", accountId: "a" }],
        requestedBy: input.requestedBy,
        reason: "limit",
      },
      { count: 2, windowMs: 60_000, scope: () => true },
    );
  const outcomes = await Promise.all([run("one"), run("two"), run("three"), run("one")]);
  expect(executions).toBe(2);
  expect(notices).toBe(0);
  expect(outcomes.filter((outcome) => "overLimit" in outcome)).toEqual([
    { overLimit: { recent: 2 } },
  ]);
  const [listed] = await actions.list();
  expect(listed).toMatchObject({ authorizedBy: "standing-grant", state: "executed" });
  // The repeated requestId reported the first run instead of running again.
  expect(outcomes[3]).toMatchObject({ ran: false, request: { requestId: "one" } });
  expect(await actions.list({ pendingOnly: true })).toHaveLength(0);
  await expect(actions.resolve("one", "approve")).rejects.toThrow("already executed");
});

test("unattended allowance survives unrelated eviction and reload; interrupted runs never replay", async () => {
  let durable: NodeActionRequest[] = [];
  let executions = 0;
  const options = {
    load: async () => structuredClone(durable),
    save: async (rows: NodeActionRequest[]) => {
      durable = structuredClone(rows);
    },
    emit: () => {},
    executors: {
      "switch-agent-account": async () => {
        executions++;
        return { code: "ok", message: "done" };
      },
    },
  };
  const actions = new NodeActionRequests(options);
  const switchInput = { ...input, kind: "switch-agent-account" as const };
  const limit = { count: 3, windowMs: 3_600_000, scope: () => true };
  for (let i = 0; i < 3; i++)
    await actions.runUnattended({ ...switchInput, requestId: "switch-" + i }, limit);
  for (let i = 0; i < 205; i++) await actions.create({ ...input, requestId: "ordinary-" + i });
  const restarted = new NodeActionRequests(options);
  expect(await restarted.runUnattended({ ...switchInput, requestId: "fourth" }, limit)).toEqual({
    overLimit: { recent: 3 },
  });
  durable[0]!.state = "approved";
  const interrupted = new NodeActionRequests(options);
  expect(
    await interrupted.runUnattended({ ...switchInput, requestId: "switch-0" }, limit),
  ).toMatchObject({
    ran: false,
    request: { state: "outcome-unknown", result: { code: "interrupted" } },
  });
  expect(executions).toBe(3);
  expect(String(durable[0]!.state)).toBe("outcome-unknown");
});

test("initial unattended save failure releases reservation and allows an exact retry", async () => {
  let fail = true;
  let executions = 0;
  const actions = new NodeActionRequests({
    load: async () => [],
    save: async () => {
      if (fail) throw new Error("disk failure");
    },
    emit: () => {},
    executors: {
      "switch-agent-account": async () => {
        executions++;
        return { code: "ok", message: "done" };
      },
    },
  });
  const request = { ...input, kind: "switch-agent-account" as const, requestId: "retry" };
  const limit = { count: 1, windowMs: 3_600_000, scope: () => true };
  await expect(actions.runUnattended(request, limit)).rejects.toThrow("disk failure");
  expect(await actions.get("retry")).toBeNull();
  expect(executions).toBe(0);
  fail = false;
  expect(await actions.runUnattended(request, limit)).toMatchObject({
    ran: true,
    request: { state: "executed" },
  });
});

test.each(["failed", "outcome-unknown"] as const)(
  "only definite failure releases allowance (%s)",
  async (state) => {
    const actions = new NodeActionRequests({
      load: async () => [],
      save: async () => {},
      emit: () => {},
      executors: {
        "switch-agent-account": async () => {
          if (state === "failed") throw new Error("refused");
          return { code: "unknown", message: "check target", outcomeUnknown: true };
        },
      },
    });
    const request = { ...input, kind: "switch-agent-account" as const, requestId: "first" };
    const limit = { count: 1, windowMs: 3_600_000, scope: () => true };
    expect(await actions.runUnattended(request, limit)).toMatchObject({ request: { state } });
    const next = await actions.runUnattended({ ...request, requestId: "next" }, limit);
    if (state === "failed") expect(next).toMatchObject({ ran: true });
    else expect(next).toEqual({ overLimit: { recent: 1 } });
  },
);
