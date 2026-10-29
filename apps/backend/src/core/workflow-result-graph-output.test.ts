import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactTypeDef } from "@orkestrator/protocol/graphs/artifact-type-def";
import { graphProvenanceDroppedSchema } from "@orkestrator/protocol/graphs/provenance";
import {
  GraphTypeLibrary,
  graphBuiltInType,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { WorkflowResultSlotInput } from "@orkestrator/protocol/workflow-results";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import {
  graphOutputCombinedSchema,
  graphOutputPortIssues,
  graphOutputSlotInput,
  splitGraphOutputCombined,
  type GraphOutputStructuredPort,
} from "./workflow-result-graph-output.js";
import type { WorkflowResultEnvironmentRequest } from "./workflow-result-registry.js";
import { WorkflowResultService } from "./workflow-result-service.js";

/**
 * Graph output slots end to end: the runtime opens one `graph-output` slot per
 * output port, mints one capability for the activation, and a model (here a
 * scripted fake provider) talks to the real agent tool server over HTTP.
 */

type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown> & { properties?: Record<string, unknown> };
};
type RpcBody = {
  result?: {
    tools?: Tool[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

const scope = { environmentId: "env-1", projectId: "project-1" };

const DESIGN_BRIEF: ArtifactTypeDef = {
  name: "design-brief",
  version: 1,
  description: "A short design proposal.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "approach", "risks"],
    properties: {
      title: { type: "string" },
      approach: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
    },
  },
  storage: "value",
  budgets: { maxBytes: 8_192, maxStringBytes: 200, maxItems: 8 },
};

const SHORTLIST: ArtifactTypeDef = {
  name: "design-shortlist",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["options", "dropped"],
    properties: {
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sources"],
          properties: {
            title: { type: "string" },
            sources: { type: "array", items: { type: "string" }, "x-orkestrator-sources": true },
          },
        },
      },
      dropped: graphProvenanceDroppedSchema(),
    },
  },
  storage: "value",
  budgets: { maxBytes: 16_384 },
};

const library = new GraphTypeLibrary([DESIGN_BRIEF, SHORTLIST]);

function type(ref: string): GraphTypeDefinition {
  const resolved = library.resolve(ref);
  if (!resolved.ok || resolved.type.kind !== "named") throw new Error(`no type ${ref}`);
  return resolved.type.definition;
}

const brief = { title: "Cache sessions", approach: "An LRU in front of the parser.", risks: [] };

describe("graph output slots", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer;

  async function rpc(
    url: string,
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<RpcBody & { status: number }> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        ...(params ? { params } : {}),
      }),
    });
    const text = await response.text();
    if (response.status !== 200) return { status: response.status };
    const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? (text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "{}")
      : text;
    return { status: response.status, ...(JSON.parse(payload) as RpcBody) };
  }

  /** The fake provider's tool client for one connection. */
  function client(connection: { url: string; token: string }) {
    return {
      list: async () =>
        (await rpc(connection.url, connection.token, "tools/list")).result?.tools ?? [],
      call: async (name: string, args: Record<string, unknown>) =>
        (await rpc(connection.url, connection.token, "tools/call", { name, arguments: args }))
          .result ?? {},
    };
  }

  async function openSlot(
    port: Parameters<typeof graphOutputSlotInput>[1],
    definition: GraphTypeDefinition,
    options?: Parameters<typeof graphOutputSlotInput>[3],
  ): Promise<WorkflowResultSlotInput> {
    const slot = graphOutputSlotInput(
      { resultKey: crypto.randomUUID(), ...scope, provider: "codex" },
      port,
      definition,
      options,
    );
    await workflowResults.prepare(slot);
    return slot;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-graph-output-"));
    storage = new StorageService(dataDir);
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("each output port of an activation gets its own submit and validate tools", async () => {
    const briefSlot = await openSlot(
      { name: "brief", description: "The design you propose for the ticket." },
      type("design-brief@1"),
    );
    const decisionSlot = await openSlot(
      { name: "decision", choices: ["simplicity", "security"] },
      graphBuiltInType("decision@1")!,
    );
    const tools = await client(
      server.workflowResultActivationConnection(scope.environmentId, scope.projectId, "host", [
        briefSlot.resultKey,
        decisionSlot.resultKey,
      ]),
    ).list();
    expect(tools.map((tool) => tool.name)).toEqual([
      "validate_brief",
      "submit_brief",
      "validate_decision",
      "submit_decision",
      "get_workflow_result_status",
    ]);
    const submitBrief = tools[1]!;
    expect(submitBrief.title).toBe("Submit brief");
    expect(submitBrief.description).toContain("The design you propose for the ticket.");
    expect(submitBrief.description).toContain("design-brief@1");
    expect(submitBrief.description).toContain("use validate_brief instead");
    expect(submitBrief.inputSchema?.properties?.result).toMatchObject({
      type: "object",
      required: ["title", "approach", "risks"],
    });
    // A decision port's schema offers exactly the port's choices.
    expect(tools[3]!.inputSchema?.properties?.result).toMatchObject({
      properties: { choice: { enum: ["simplicity", "security"] } },
    });
    // No other agent tool rides on the activation capability.
    expect(
      tools.some((tool) => tool.name === "create_ticket" || tool.name === "send_message"),
    ).toBe(false);
  });

  test("a fake provider submits, is refused, repairs and is accepted on every port", async () => {
    const briefSlot = await openSlot({ name: "brief" }, type("design-brief@1"));
    const decisionSlot = await openSlot(
      { name: "decision", choices: ["simplicity", "security"] },
      graphBuiltInType("decision@1")!,
    );
    const model = client(
      server.workflowResultActivationConnection(scope.environmentId, scope.projectId, "host", [
        briefSlot.resultKey,
        decisionSlot.resultKey,
      ]),
    );

    // Dry run: over the type's string budget. Nothing is spent.
    const tooLong = { ...brief, approach: "x".repeat(300) };
    const dryRun = await model.call("validate_brief", {
      resultKey: briefSlot.resultKey,
      result: tooLong,
    });
    expect(dryRun.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "invalid_result",
        nextAction: "correct",
        issues: [{ path: "$.approach", code: "too_large" }],
      },
    });
    expect(await workflowResults.projection(briefSlot.resultKey)).toBe("preparing");

    // The submission is refused the same way and spends one correction.
    const refused = await model.call("submit_brief", {
      resultKey: briefSlot.resultKey,
      result: tooLong,
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: { code: "invalid_result" } });
    expect(await workflowResults.projection(briefSlot.resultKey)).toBe("correcting");

    // A slip of the key names the port's own key.
    const slip = await model.call("submit_brief", {
      resultKey: decisionSlot.resultKey,
      result: brief,
    });
    expect(slip.structuredContent).toMatchObject({
      error: { issues: [{ code: "result_key_mismatch" }] },
    });
    expect(JSON.stringify(slip)).toContain(briefSlot.resultKey);

    // Repair, validate, then commit by digest.
    const validated = await model.call("validate_brief", {
      resultKey: briefSlot.resultKey,
      result: brief,
    });
    const digest = (validated.structuredContent as { validatedDigest: string }).validatedDigest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const accepted = await model.call("submit_brief", {
      resultKey: briefSlot.resultKey,
      validatedDigest: digest,
    });
    expect(accepted.structuredContent).toMatchObject({ ok: true, duplicate: false });

    // The decision port: the domain validator wants a rationale.
    const noRationale = await model.call("submit_decision", {
      resultKey: decisionSlot.resultKey,
      result: { choice: "security", rationale: " " },
    });
    expect(noRationale.structuredContent).toMatchObject({
      error: { code: "invalid_result", issues: [{ path: "$.rationale", code: "empty" }] },
    });
    const decided = await model.call("submit_decision", {
      resultKey: decisionSlot.resultKey,
      result: { choice: "security", rationale: "The smallest attack surface." },
    });
    expect(decided.structuredContent).toMatchObject({ ok: true });

    // One status tool answers for both ports.
    for (const slot of [briefSlot, decisionSlot]) {
      const status = await model.call("get_workflow_result_status", { resultKey: slot.resultKey });
      expect(status.structuredContent).toMatchObject({ lifecycle: "accepted" });
    }
    const unknown = await model.call("get_workflow_result_status", {
      resultKey: crypto.randomUUID(),
    });
    expect(unknown.structuredContent).toMatchObject({
      error: { code: "invalid_result", issues: [{ code: "result_key_mismatch" }] },
    });
    expect(await workflowResults.structured(briefSlot.resultKey)).toMatchObject({ value: brief });
    expect(await workflowResults.structured(decisionSlot.resultKey)).toMatchObject({
      value: {
        choice: "security",
        rationale: "The smallest attack surface.",
      },
    });
  });

  test("a single port uses the attempt connection with the same per-port tools", async () => {
    const slot = await openSlot({ name: "brief" }, type("design-brief@1"));
    const connection = server.workflowResultConnection(
      scope.environmentId,
      scope.projectId,
      "host",
      slot.resultKey,
    );
    const model = client(connection);
    expect((await model.list()).map((tool) => tool.name)).toEqual([
      "validate_brief",
      "submit_brief",
      "get_workflow_result_status",
    ]);
    expect(
      (await model.call("submit_brief", { resultKey: slot.resultKey, result: brief }))
        .structuredContent,
    ).toMatchObject({ ok: true });

    // A restarted backend lists the same tools from the persisted slot.
    await server.stop();
    workflowResults.closeStorage();
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    await server.start();
    const renewed = server.workflowResultConnection(
      scope.environmentId,
      scope.projectId,
      "host",
      slot.resultKey,
    );
    expect((await client(renewed).list()).map((tool) => tool.name)).toEqual([
      "validate_brief",
      "submit_brief",
      "get_workflow_result_status",
    ]);
  });

  test("an activation capability covers only the graph output slots it was signed for", async () => {
    const first = await openSlot({ name: "brief" }, type("design-brief@1"));
    const second = await openSlot({ name: "notes" }, graphBuiltInType("markdown@1")!);
    const keys = [first.resultKey, second.resultKey];
    const token = workflowResults.activationCapabilityToken(scope, keys);
    expect(await workflowResults.authenticateActivationCapability(token)).toEqual({
      ...scope,
      workflowResultKeys: keys,
    });
    // Single-key tokens are not activation tokens, and the reverse.
    expect(await workflowResults.authenticateCapability(token)).toBeNull();
    expect(
      await workflowResults.authenticateActivationCapability(
        workflowResults.capabilityToken(scope, first.resultKey),
      ),
    ).toBeNull();
    // Tampering with the key list or the signature, another scope, or a built-in slot.
    const reordered = workflowResults.activationCapabilityToken(scope, [...keys].reverse());
    expect(
      await workflowResults.authenticateActivationCapability(
        `${keys.join("_")}${reordered.slice(reordered.indexOf("."))}`,
      ),
    ).toBeNull();
    expect(
      await workflowResults.authenticateActivationCapability(
        workflowResults.activationCapabilityToken({ ...scope, projectId: "other" }, keys),
      ),
    ).toBeNull();
    const builtIn = crypto.randomUUID();
    await workflowResults.prepare({
      resultKey: builtIn,
      kind: "fix-result",
      ...scope,
      provider: "codex",
    });
    expect(
      await workflowResults.authenticateActivationCapability(
        workflowResults.activationCapabilityToken(scope, [first.resultKey, builtIn]),
      ),
    ).toBeNull();
    const denied = await rpc(
      server.workflowResultActivationConnection(scope.environmentId, scope.projectId, "host", [
        first.resultKey,
        builtIn,
      ]).url,
      workflowResults.activationCapabilityToken(scope, [first.resultKey, builtIn]),
      "tools/list",
    );
    expect(denied.status).toBe(401);
    expect(() => workflowResults.activationCapabilityToken(scope, [first.resultKey])).toThrow();
  });

  test("a port without a declaration uses the generic graph output tools", async () => {
    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({ resultKey, kind: "graph-output", ...scope, provider: "codex" });
    const model = client(
      server.workflowResultConnection(scope.environmentId, scope.projectId, "host", resultKey),
    );
    expect((await model.list()).map((tool) => tool.name)).toEqual([
      "validate_workflow_result",
      "submit_graph_output",
      "get_workflow_result_status",
    ]);
    expect(
      (await model.call("submit_graph_output", { resultKey, result: { anything: [1, 2] } }))
        .structuredContent,
    ).toMatchObject({ ok: true });
  });

  test("a built-in type keeps the backend's placeholder check through its result kind", async () => {
    const slot = await openSlot({ name: "report" }, graphBuiltInType("review-report@1")!);
    const report = structuredClone(
      graphBuiltInType("review-report@1")!.example,
    ) as StructuredReviewReport;
    const probe = await workflowResults.submit(scope, slot.resultKey, {
      ...report,
      reviewSummary: "probe",
    });
    expect(probe).toMatchObject({
      ok: false,
      error: { issues: [{ path: "$.reviewSummary", code: "placeholder_value" }] },
    });
    expect(await workflowResults.submit(scope, slot.resultKey, report)).toMatchObject({ ok: true });
  });

  test("a consolidating custom type's citations are checked against the node's inputs", async () => {
    const slot = await openSlot(
      { name: "shortlist", provenance: "accountForAll" },
      type("design-shortlist@1"),
      {
        sources: { "brief-1": "design-brief@1", "brief-2": "design-brief@1" },
      },
    );
    const model = client(
      server.workflowResultConnection(scope.environmentId, scope.projectId, "host", slot.resultKey),
    );
    // The provider never sees the provenance annotation.
    const submit = (await model.list()).find((tool) => tool.name === "submit_shortlist")!;
    expect(JSON.stringify(submit.inputSchema)).not.toContain("x-orkestrator-sources");

    const invented = await model.call("submit_shortlist", {
      resultKey: slot.resultKey,
      result: { options: [{ title: "Cache", sources: ["brief-1", "brief-7"] }], dropped: [] },
    });
    expect(invented.structuredContent).toMatchObject({
      error: {
        code: "invalid_result",
        issues: [
          { path: "$.options[0].sources[1]", code: "invalid_value" },
          { path: "$.dropped", code: "unaccounted_source" },
        ],
      },
    });
    const repaired = await model.call("submit_shortlist", {
      resultKey: slot.resultKey,
      result: {
        options: [{ title: "Cache", sources: ["brief-1"] }],
        dropped: [{ id: "brief-2", reason: "Needs a schema migration." }],
      },
    });
    expect(repaired.structuredContent).toMatchObject({ ok: true });
  });

  test("a slot the runtime built wrongly is refused when it is prepared", async () => {
    const base = { ...scope, provider: "codex" as const };
    const valid = graphOutputSlotInput(
      { resultKey: crypto.randomUUID(), ...base },
      { name: "brief" },
      type("design-brief@1"),
    );
    const refused = async (slot: Partial<WorkflowResultSlotInput>, message: string) =>
      expect(
        workflowResults.prepare({ ...valid, resultKey: crypto.randomUUID(), ...slot } as never),
      ).rejects.toThrow(message);
    await refused({ toolName: "submit_other" }, "its own port");
    await refused({ toolName: "submit_review_report" }, "unreserved port");
    await refused({ schema: undefined }, "carries its schema");
    await refused({ schema: { type: "object", pattern: "x" } }, "portable subset");
    await refused({ context: { ...valid.context, port: "review_report" } as never }, "reserved");
    await refused(
      { context: { ...valid.context, budgets: undefined } as never },
      "storage and budgets",
    );
    await refused(
      {
        context: {
          ...valid.context,
          provenance: { mode: "cite", fields: [{ segments: ["title"] }], sources: {} },
        } as never,
      },
      "not a sources field",
    );
    const decision = graphOutputSlotInput(
      { resultKey: crypto.randomUUID(), ...base },
      { name: "decision", choices: ["a", "b"] },
      graphBuiltInType("decision@1")!,
    );
    await expect(
      workflowResults.prepare({ ...decision, schema: graphBuiltInType("decision@1")!.schema }),
    ).rejects.toThrow("does not match decision@1");
    await expect(
      workflowResults.prepare({
        ...decision,
        resultKey: crypto.randomUUID(),
        context: { ...decision.context, storage: "value" } as never,
      }),
    ).rejects.toThrow("type library");
    await expect(
      workflowResults.prepare({
        resultKey: crypto.randomUUID(),
        kind: "fix-result",
        ...base,
        toolName: "submit_fix",
      }),
    ).rejects.toThrow("Only graph output slots");
    // Rebinding a key to another port is refused like any other rebinding.
    await workflowResults.prepare(valid);
    await workflowResults.prepare(valid);
    await expect(
      workflowResults.prepare(
        graphOutputSlotInput(
          { resultKey: valid.resultKey, ...base },
          { name: "other" },
          type("design-brief@1"),
        ),
      ),
    ).rejects.toThrow("already bound");
  });
});

describe("environment checks through the registry hook", () => {
  let dataDir: string;
  let workflowResults: WorkflowResultService;
  const head = "a".repeat(40);
  const workspace = { branch: "feature/cache", headRef: head, baseRef: null };

  async function workspaceSlot(): Promise<string> {
    const slot = graphOutputSlotInput(
      { resultKey: crypto.randomUUID(), ...scope, provider: "claude" },
      { name: "code" },
      graphBuiltInType("workspace@1")!,
    );
    await workflowResults.prepare(slot);
    return slot.resultKey;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-graph-output-env-"));
    workflowResults = new WorkflowResultService(dataDir);
  });

  afterEach(async () => {
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("without a hook a value that needs the environment is refused, never accepted unchecked", async () => {
    const resultKey = await workspaceSlot();
    for (const outcome of [
      await workflowResults.validate(scope, resultKey, workspace),
      await workflowResults.submit(scope, resultKey, workspace),
    ]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable", nextAction: "lookup_or_resubmit" },
      });
    }
    // No correction was spent.
    expect(await workflowResults.projection(resultKey)).toBe("preparing");
  });

  test("the hook's issues are corrections; its failures are refusals; a pass is accepted", async () => {
    const requests: WorkflowResultEnvironmentRequest[] = [];
    let answer: "missing" | "throw" | "ok" = "missing";
    workflowResults.setEnvironmentValidator(async (request) => {
      requests.push(request);
      if (answer === "throw") throw new Error("container stopped");
      return answer === "missing"
        ? [{ path: "$.headRef", code: "unknown_commit", message: "The commit does not exist." }]
        : [];
    });
    const resultKey = await workspaceSlot();
    expect(await workflowResults.validate(scope, resultKey, workspace)).toMatchObject({
      ok: false,
      error: { code: "invalid_result", issues: [{ path: "$.headRef", code: "unknown_commit" }] },
    });
    expect(await workflowResults.submit(scope, resultKey, workspace)).toMatchObject({
      ok: false,
      error: { code: "invalid_result", issues: [{ code: "unknown_commit" }] },
    });
    expect(await workflowResults.projection(resultKey)).toBe("correcting");

    answer = "throw";
    expect(await workflowResults.submit(scope, resultKey, workspace)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(await workflowResults.projection(resultKey)).toBe("correcting");

    answer = "ok";
    const validation = await workflowResults.validate(scope, resultKey, workspace);
    expect(validation).toMatchObject({ ok: true });
    const digest = (validation as { validatedDigest: string }).validatedDigest;
    expect(await workflowResults.submitValidated(scope, resultKey, digest)).toMatchObject({
      ok: true,
    });
    expect(requests.at(-1)).toEqual({
      attempt: { resultKey, kind: "graph-output", ...scope },
      validator: "workspace-commit",
      value: workspace,
    });
    // A value the pure checks refuse never reaches the environment.
    const before = requests.length;
    const other = await workspaceSlot();
    await workflowResults.submit(scope, other, { ...workspace, headRef: "not-a-sha" });
    expect(requests.length).toBe(before);
  });

  test("a validation plan port is checked against the workspace HEAD through the hook", async () => {
    const requests: WorkflowResultEnvironmentRequest[] = [];
    workflowResults.setEnvironmentValidator(async (request) => {
      requests.push(request);
      return request.validator === "validation-plan"
        ? [{ path: "$.headRef", code: "head_mismatch", message: "Not the workspace HEAD." }]
        : [];
    });
    const slot = graphOutputSlotInput(
      { resultKey: crypto.randomUUID(), ...scope, provider: "claude" },
      { name: "plan" },
      graphBuiltInType("validation-plan@1")!,
    );
    await workflowResults.prepare(slot);
    const plan = graphBuiltInType("validation-plan@1")!.example;
    expect(await workflowResults.submit(scope, slot.resultKey, plan)).toMatchObject({
      ok: false,
      error: { code: "invalid_result", issues: [{ code: "head_mismatch" }] },
    });
    expect(requests.map((request) => request.validator)).toEqual(["validation-plan"]);
  });
});

describe("structured-output transport: one combined schema per activation", () => {
  const ports: GraphOutputStructuredPort[] = [
    {
      port: "brief",
      schema: type("design-brief@1").schema,
      required: true,
      description: "The design you propose.",
    },
    { port: "shortlist", schema: type("design-shortlist@1").schema, required: false },
  ];

  test("the combined schema has one required property per port, optional ones nullable", () => {
    const combined = graphOutputCombinedSchema(ports) as Record<string, unknown> & {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(combined).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["brief", "shortlist"],
    });
    expect(combined.properties.brief).toMatchObject({
      type: "object",
      description: "The design you propose.",
    });
    expect(combined.properties.shortlist!.anyOf).toEqual([
      expect.objectContaining({ type: "object" }),
      { type: "null" },
    ]);
    expect(JSON.stringify(combined)).not.toContain("x-orkestrator-sources");
    expect(() => graphOutputCombinedSchema([])).toThrow();
    expect(() => graphOutputCombinedSchema([ports[0]!, ports[0]!])).toThrow("twice");
  });

  test("the runtime splits the answer by port and maps slot issues back", () => {
    expect(splitGraphOutputCombined(ports, { brief, shortlist: null })).toEqual({
      ok: true,
      outputs: [{ port: "brief", value: brief }],
      omitted: ["shortlist"],
    });
    const shortlist = { options: [], dropped: [] };
    expect(splitGraphOutputCombined(ports, { brief, shortlist })).toEqual({
      ok: true,
      outputs: [
        { port: "brief", value: brief },
        { port: "shortlist", value: shortlist },
      ],
      omitted: [],
    });
    const broken = splitGraphOutputCombined(ports, { brief: null, extra: 1 });
    expect(broken).toEqual({
      ok: false,
      issues: [
        { path: "$.extra", code: "unknown_field", message: "Not an output of this step" },
        { path: "$.brief", code: "missing_field", message: "This output is required" },
        {
          path: "$.shortlist",
          code: "missing_field",
          message: "Give this output, or null to omit it",
        },
      ],
    });
    expect(splitGraphOutputCombined(ports, [brief])).toMatchObject({ ok: false });
    expect(
      graphOutputPortIssues("brief", [
        { path: "$.approach", code: "too_large", message: "Too long" },
        { path: "$", code: "invalid_type", message: "Expected object" },
      ]),
    ).toEqual([
      { path: "$.brief.approach", code: "too_large", message: "Too long" },
      { path: "$.brief", code: "invalid_type", message: "Expected object" },
    ]);
  });
});
