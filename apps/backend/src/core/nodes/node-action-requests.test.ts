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
