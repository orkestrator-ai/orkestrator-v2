import { describe, expect, test } from "bun:test";
import {
  activationFixture,
  artifactFixture,
  graphRunFixture,
} from "./run-fixtures.test-support.js";
import { graphLineageDescendants } from "./run-lineage.js";
import type { GraphArtifact, GraphRun, NodeActivation } from "./run-model.js";
import {
  graphRestartScope,
  graphRunCodeRewindBlocker,
  graphRunRestartBlocker,
} from "./run-rewind.js";

/**
 * Two rounds of the §9.2 loop. Round 1: build → prepare → package → review →
 * has-issues (issues) → address → verify; fix is a later-only entry, skipped.
 * Round 2: fix (carried from verify@1) → prepare → package → review →
 * has-issues (clean) → verify; address is skipped.
 */
function twoRounds(): { run: GraphRun; artifacts: GraphArtifact[]; key: (id: string) => string } {
  const base = graphRunFixture();
  const artifacts: GraphArtifact[] = [];
  const activations: NodeActivation[] = [];
  const target = artifactFixture(base.id);
  const ticket = artifactFixture(base.id, {
    type: "ticket@1",
    producer: { nodeId: "$input", activation: "$input", port: "ticket" },
    value: { id: "t1" },
  });
  artifacts.push(target, ticket);
  const add = (
    nodeId: string,
    iteration: number,
    inputs: Record<string, string>,
    outputs: string[],
    overrides: Partial<NodeActivation> = {},
  ): Record<string, string> => {
    const activation = activationFixture({ nodeId, iteration }, { inputs, ...overrides });
    const produced: Record<string, string> = {};
    for (const port of outputs) {
      const artifact = artifactFixture(base.id, {
        activation,
        port,
        type: "text@1",
        value: { text: `${nodeId}.${port}@${iteration}` },
        inputs: Object.values(inputs),
      });
      artifacts.push(artifact);
      produced[port] = artifact.id;
    }
    activation.outputs = { ...produced, ...overrides.outputs };
    activations.push(activation);
    return activation.outputs;
  };
  const build = add("build", 1, { ticket: ticket.id, code: target.id }, ["code", "report"]);
  add("fix", 1, {}, [], { state: "skipped" });
  const prepare1 = add("prepare", 1, { code: build.code! }, ["plan", "code"]);
  const package1 = add("package", 1, { plan: prepare1.plan!, code: prepare1.code! }, ["package"]);
  const review1 = add("review", 1, { package: package1.package!, ticket: ticket.id }, ["report"]);
  // The gate forwards its inputs on the taken outlet.
  add("has-issues", 1, { report: review1.report!, code: prepare1.code! }, [], {
    outlet: "issues",
    outputs: { report: review1.report!, code: prepare1.code! },
  });
  const address1 = add("address", 1, { report: review1.report!, code: prepare1.code! }, [
    "code",
    "report",
  ]);
  const verify1 = add(
    "verify",
    1,
    { ticket: ticket.id, code: address1.code!, address: address1.report! },
    ["verdict", "code"],
  );
  const fix2 = add(
    "fix",
    2,
    { ticket: ticket.id, feedback: verify1.verdict!, code: verify1.code! },
    ["code", "report"],
  );
  const prepare2 = add("prepare", 2, { code: fix2.code! }, ["plan", "code"]);
  const package2 = add("package", 2, { plan: prepare2.plan!, code: prepare2.code! }, ["package"]);
  const review2 = add("review", 2, { package: package2.package!, ticket: ticket.id }, ["report"]);
  add("has-issues", 2, { report: review2.report!, code: prepare2.code! }, [], {
    outlet: "clean",
    outputs: { report: review2.report!, code: prepare2.code! },
  });
  add("address", 2, {}, [], { state: "skipped" });
  add("verify", 2, { ticket: ticket.id, code: prepare2.code! }, ["verdict", "code"]);
  const run: GraphRun = {
    ...base,
    status: "complete",
    activations,
    loopIterations: { rounds: 2 },
    bindings: { ...base.bindings, inputs: { target: target.id, ticket: ticket.id } },
  };
  const key = (id: string) => {
    const [nodeId, iteration] = id.split("@");
    return run.activations.find(
      (activation) =>
        activation.nodeId === nodeId && activation.iteration === Number(iteration ?? 1),
    )!.key;
  };
  return { run, artifacts, key };
}

const produced = (artifacts: GraphArtifact[], run: GraphRun, ids: string[]) =>
  artifacts
    .filter((artifact) =>
      ids.some(
        (id) => artifact.producer.activation === run.activations.find((a) => a.key === id)?.key,
      ),
    )
    .map((artifact) => artifact.id)
    .sort();

describe("graphRestartScope", () => {
  test("restarting a gate keeps what it forwarded and supersedes exactly its readers", () => {
    const { run, artifacts, key } = twoRounds();
    const scope = graphRestartScope(run, artifacts, key("has-issues@1"))!;
    const expected = [
      "has-issues@1",
      "address@1",
      "verify@1",
      "fix@2",
      "prepare@2",
      "package@2",
      "review@2",
      "has-issues@2",
      "address@2",
      "verify@2",
    ].map(key);
    expect(scope.activations).toEqual(expected);
    // The forwarded review report and prepared code belong to their producers.
    expect(scope.artifacts).toEqual(produced(artifacts, run, expected));
    for (const kept of ["build", "prepare@1", "package@1", "review@1", "fix@1"]) {
      expect(scope.activations).not.toContain(key(kept));
    }
    // The loop rewinds to the gate's iteration.
    expect(scope.loopIterations).toEqual({ rounds: 1 });
  });

  test("a restart in the last iteration supersedes the skipped and clean-outlet readers only", () => {
    const { run, artifacts, key } = twoRounds();
    const scope = graphRestartScope(run, artifacts, key("review@2"))!;
    // address@2 was skipped and verify@2 read the gate's clean outlet: neither
    // consumed review@2's report, but both depend on the gate's decision.
    expect(scope.activations).toEqual(
      ["review@2", "has-issues@2", "address@2", "verify@2"].map(key),
    );
    expect(scope.loopIterations).toEqual({});
  });

  test("inside a loop the later iterations go, the earlier ones and the carry sources stay", () => {
    const { run, artifacts, key } = twoRounds();
    const scope = graphRestartScope(run, artifacts, key("fix@2"))!;
    expect(scope.activations).toEqual(
      ["fix@2", "prepare@2", "package@2", "review@2", "has-issues@2", "address@2", "verify@2"].map(
        key,
      ),
    );
    // verify@1's verdict and code (fix@2's carried inputs) stay live.
    const verify1 = run.activations.find((activation) => activation.key === key("verify@1"))!;
    for (const id of Object.values(verify1.outputs)) expect(scope.artifacts).not.toContain(id);
    expect(scope.loopIterations).toEqual({});
  });

  test("restarting the node before the loop supersedes everything after it and rewinds the loop", () => {
    const { run, artifacts, key } = twoRounds();
    const scope = graphRestartScope(run, artifacts, key("build"))!;
    // Every activation but the skipped fix@1 (which read nothing build made).
    expect(scope.activations).toHaveLength(run.activations.length - 1);
    expect(scope.activations).not.toContain(key("fix@1"));
    expect(scope.loopIterations).toEqual({ rounds: 1 });
  });

  test("superseded activations and artifacts are left out; unknown and superseded roots are null", () => {
    const { run, artifacts, key } = twoRounds();
    const rewound: GraphRun = {
      ...run,
      rewinds: [
        {
          id: "r1",
          kind: "restart",
          nodeId: "verify",
          activation: key("verify@2"),
          iteration: 2,
          requestedAt: run.createdAt,
          requestedBy: "user",
          superseded: { activations: [key("verify@2")], artifacts: [] },
        },
      ],
      activations: run.activations.map((activation) =>
        activation.key === key("verify@2")
          ? { ...activation, state: "superseded" as const, supersededBy: "r1" }
          : activation,
      ),
    };
    expect(graphRestartScope(rewound, artifacts, key("verify@2"))).toBeNull();
    expect(graphRestartScope(rewound, artifacts, "nope#iter=1#attempt=1")).toBeNull();
    expect(graphRestartScope(rewound, artifacts, key("has-issues@2"))!.activations).toEqual([
      key("has-issues@2"),
      key("address@2"),
    ]);
  });

  test("the lineage of a forwarding node no longer reaches its upstream producers", () => {
    const { run, artifacts, key } = twoRounds();
    const lineage = graphLineageDescendants(run, artifacts, key("has-issues@1"))!;
    expect(lineage.activations).toEqual([key("has-issues@1")]);
    expect(lineage.artifacts).toEqual([]);
  });
});

describe("restart and code-rewind blockers", () => {
  test("restart refuses provisioning, stopping, superseded and replaced attempts", () => {
    const { run, key } = twoRounds();
    expect(graphRunRestartBlocker(run, key("review@2"))).toBeUndefined();
    expect(graphRunRestartBlocker({ ...run, status: "provisioning" }, key("build"))).toContain(
      "preparing",
    );
    expect(graphRunRestartBlocker({ ...run, status: "cancelling" }, key("build"))).toContain(
      "stopping",
    );
    expect(graphRunRestartBlocker(run, "nope#iter=1#attempt=1")).toContain("no such");
    const retried: GraphRun = {
      ...run,
      activations: [
        ...run.activations,
        activationFixture({ nodeId: "build", attempt: 2 }, { state: "complete" }),
      ],
    };
    expect(graphRunRestartBlocker(retried, key("build"))).toContain("later attempt");
    const superseded: GraphRun = {
      ...run,
      activations: run.activations.map((activation) =>
        activation.key === key("build")
          ? { ...activation, state: "superseded" as const, supersededBy: "r1" }
          : activation,
      ),
    };
    expect(graphRunRestartBlocker(superseded, key("build"))).toContain("previous attempt");
  });

  test("code rewind needs a quiet workspace and a live run", () => {
    const { run, key } = twoRounds();
    expect(graphRunCodeRewindBlocker(run, key("fix@2"))).toBeUndefined();
    expect(graphRunCodeRewindBlocker({ ...run, status: "paused" }, key("fix@2"))).toBeUndefined();
    expect(graphRunCodeRewindBlocker({ ...run, mock: true }, key("fix@2"))).toContain("mock");
    expect(graphRunCodeRewindBlocker({ ...run, status: "running" }, key("fix@2"))).toContain(
      "Pause the run first",
    );
    const busy: GraphRun = {
      ...run,
      status: "paused",
      activations: run.activations.map((activation) =>
        activation.key === key("verify@2")
          ? { ...activation, state: "running" as const }
          : activation,
      ),
    };
    expect(graphRunCodeRewindBlocker(busy, key("fix@2"))).toContain("running node");
  });
});
