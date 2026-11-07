/**
 * The `graphs` domain (plan item 7007): its 39 definitions classify reads as
 * the routing classifier does, results keep every key the backend sends, the
 * graph guards refine templates and runs tolerantly (an added field or status
 * passes, a broken record does not), and its client sends typed, enveloped
 * calls to a node with the domain while a pre-contract node gets today's
 * untyped calls.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { graphTemplateExample } from "../../../graphs/examples.js";
import { graphRunFixture } from "../../../graphs/run-fixtures.test-support.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import {
  decodeCommandArgs,
  decodeCommandResult,
  validateCommandResult,
  type AnyCommandDef,
} from "../../command.js";
import {
  GRAPHS_COMMANDS,
  GraphRunSchema,
  GraphTemplateSchema,
  graphRunGetCommand,
  graphRunLaunchCommand,
  graphTemplateGetCommand,
  graphTemplateSaveCommand,
  graphsClient,
  graphsDomain,
  tolerantGuardVerdict,
} from "./index.js";

describe("graphs definitions", () => {
  it("defines the domain's 39 commands once each, at version 1", () => {
    const names = GRAPHS_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(39);
    expect(new Set(names).size).toBe(39);
    expect(graphsDomain).toMatchObject({ name: "graphs", version: 1, min: 1 });
    for (const def of GRAPHS_COMMANDS) {
      expect(def.domain).toBe(graphsDomain);
      expect(def.since).toBe(1);
    }
  });

  it("classifies reads with the routing classifier; every command but the ceiling write is a workspace command", () => {
    for (const def of GRAPHS_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        // The project's capability ceiling is set from Settings only (plan item 7012).
        access: def.name === "graph_capability_ceiling_set" ? "admin" : "workspace",
      });
      expect(def.encoded).toBe(false);
    }
  });

  it("exports every schema as JSON Schema", () => {
    for (const def of GRAPHS_COMMANDS) {
      expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys and refuses an unknown critical one", () => {
    const decoded = decodeCommandArgs(graphTemplateGetCommand, {
      ref: { scope: "builtin", id: "multi-review" },
      future: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).not.toHaveProperty("future");
    const refused = decodeCommandArgs(
      graphTemplateGetCommand,
      { ref: { scope: "builtin", id: "multi-review" }, future: true },
      { critical: ["future"] },
    );
    expect(refused._tag).toBe("Failure");
    // A declared critical key passes; the handler still validates its value.
    const declared = decodeCommandArgs(
      graphTemplateSaveCommand,
      { template: {}, expectedRevision: 3 },
      { critical: ["expectedRevision"] },
    );
    expect(declared._tag).toBe("Success");
  });
});

describe("graph guards as schema refinements", () => {
  const template = graphTemplateExample("multi-review");
  const run = graphRunFixture();

  it("accept the guards' valid records unchanged", () => {
    expect(Schema.decodeUnknownSync(GraphTemplateSchema)(template)).toEqual(template);
    expect(Schema.decodeUnknownSync(GraphRunSchema)(run)).toEqual(run);
  });

  it("tolerate a field or a status a newer backend adds", () => {
    const newerTemplate = { ...template, futureField: { x: 1 } };
    expect(Schema.decodeUnknownSync(GraphTemplateSchema)(newerTemplate)).toEqual(newerTemplate);
    const newerRun = { ...run, futureField: true, status: "hibernating" };
    expect(Schema.decodeUnknownSync(GraphRunSchema)(newerRun)).toEqual(newerRun as never);
  });

  it("refuse a structurally broken record with the guard's message", () => {
    const broken = Schema.decodeUnknownResult(GraphTemplateSchema)({
      ...template,
      nodes: "not a list",
    });
    expect(broken._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(GraphRunSchema)({ ...run, revision: -1 })._tag).toBe(
      "Failure",
    );
    expect(Schema.decodeUnknownResult(GraphRunSchema)({ ...run, formatVersion: 99 })._tag).toBe(
      "Failure",
    );
  });

  it("names the first blocking error and ignores tolerated ones", () => {
    expect(
      tolerantGuardVerdict({
        ok: false,
        errors: [
          { path: "x", code: "unknown_field", message: "Unknown field is not permitted" },
          { path: "status", code: "enum", message: "Expected one of: a" },
        ],
        omittedErrors: 0,
      }),
    ).toBe(true);
    expect(
      tolerantGuardVerdict({
        ok: false,
        errors: [
          { path: "x", code: "unknown_field", message: "Unknown field is not permitted" },
          { path: "revision", code: "out_of_range", message: "Too small" },
        ],
        omittedErrors: 0,
      }),
    ).toBe("revision: Too small");
  });

  it("validate run results through their command", () => {
    const changed = { status: "changed", run };
    expect(validateCommandResult(graphRunGetCommand, changed)._tag).toBe("Success");
    expect(
      validateCommandResult(graphRunGetCommand, { status: "changed", run: { id: "x" } })._tag,
    ).toBe("Failure");
    expect(
      validateCommandResult(graphRunGetCommand, { status: "unchanged", revision: 3 })._tag,
    ).toBe("Success");
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(domains: NegotiatedDomains | undefined, answer: (command: string) => unknown) {
  const sent: Sent[] = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer(command);
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

const GRAPHS_V1 = { graphs: { min: 1, max: 1 } };

const launch = {
  ref: { scope: "user", id: "mine" },
  projectId: "p1",
  environment: { kind: "new", create: "worktree" },
  requestId: "r1",
};

const launched = {
  runId: "run-1",
  projectId: "p1",
  status: "pending",
  template: { id: "mine", revision: 1, name: "Mine" },
  repeated: false,
  extra: "kept",
};

describe("graphs client", () => {
  it("version 1: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode(GRAPHS_V1, () => launched);
    const client = createDomainClient(graphsClient, node.options);
    expect(client.version()).toBe(1);
    await expect(client.api().graph_run_launch(launch)).resolves.toEqual(launched as never);
    expect(node.sent).toEqual([
      {
        command: graphRunLaunchCommand.name,
        args: launch,
        envelope: { domain: "graphs", version: 1, critical: ["requestId"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode(GRAPHS_V1, () => ({ runId: 7 }));
    await expect(
      createDomainClient(graphsClient, node.options).api().graph_run_launch(launch),
    ).rejects.toThrow("Invalid result from graph_run_launch");
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacyAnswer = { runId: 7, older: true };
    const node = fakeNode(undefined, () => legacyAnswer);
    const client = createDomainClient(graphsClient, node.options);
    expect(client.version()).toBe(0);
    await expect(client.api().graph_run_launch(launch)).resolves.toBe(legacyAnswer as never);
    expect(node.invoked).toEqual([{ command: "graph_run_launch", args: launch }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["graphs", 0]]);
  });

  it("decodes a template detail and keeps every key", () => {
    const template = graphTemplateExample("multi-review");
    const detail = {
      summary: {
        ref: { scope: "builtin", id: template.id },
        scope: "builtin",
        id: template.id,
        name: template.name,
        revision: template.revision,
        digest: "d".repeat(64),
        readOnly: true,
        trust: "trusted",
        launchable: false,
        compile: {
          ok: true,
          launchable: true,
          errors: 0,
          warnings: 0,
          infos: 0,
          pendingAcknowledgements: 0,
          planDigest: null,
          cost: null,
        },
        later: 1,
      },
      template,
    };
    const decoded = decodeCommandResult(graphTemplateGetCommand, detail);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(detail as never);
  });
});
