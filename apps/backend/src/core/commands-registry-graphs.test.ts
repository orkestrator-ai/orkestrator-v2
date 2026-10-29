import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  GraphProjectCeiling,
  GraphTemplateCompileResponse,
  GraphTemplateDetail,
  GraphTemplateExport,
  GraphTemplateImportResult,
  GraphTemplatesListResult,
  GraphTemplateTrustResult,
} from "@orkestrator/protocol/graphs/library";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  createGraphTemplateFixture,
  pushingGraphTemplate,
  sampleGraphTemplate,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";

let fixture: GraphTemplateFixture;
let context: CommandContext;
const commands = createCommandRegistry();

beforeEach(async () => {
  fixture = await createGraphTemplateFixture({
    builtins: () => [{ ...graphTemplateExample("multi-review"), engine: "multi-review" }],
  });
  context = {
    storage: fixture.storage,
    graphTemplates: fixture.service,
  } as unknown as CommandContext;
});

afterEach(async () => {
  await fixture.close();
});

async function run<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = commands.get(name);
  if (!handler) throw new Error(`Not registered: ${name}`);
  return (await handler(args, context)) as T;
}

async function refused(name: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    await run(name, args);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error(`${name} was not refused`);
}

const PATH = ".orkestrator/graphs/review.graph.json";

describe("graph template commands", () => {
  test("are registered through createCommandRegistry", () => {
    for (const name of [
      "graph_templates_list",
      "graph_template_get",
      "graph_template_save",
      "graph_template_delete",
      "graph_template_duplicate",
      "graph_template_compile",
      "graph_template_import",
      "graph_template_export",
      "graph_template_trust",
      "graph_capability_ceiling_get",
      "graph_capability_ceiling_set",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("refuse when the service is missing or arguments are unknown", async () => {
    context = { storage: fixture.storage } as unknown as CommandContext;
    expect(await refused("graph_templates_list", {})).toBe("invalid-request");
    context = {
      storage: fixture.storage,
      graphTemplates: fixture.service,
    } as unknown as CommandContext;
    expect(await refused("graph_templates_list", { extra: 1 })).toBe("invalid-request");
    expect(await refused("graph_templates_list", { projectId: 5 })).toBe("invalid-request");
  });

  test("graph_templates_list returns all three scopes", async () => {
    await run("graph_template_save", { template: sampleGraphTemplate("mine") });
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("repo"));
    const list = await run<GraphTemplatesListResult>("graph_templates_list", {
      projectId: fixture.projectId,
    });
    expect(list.templates.map((entry) => [entry.scope, entry.trust])).toEqual([
      ["builtin", "trusted"],
      ["user", "trusted"],
      ["project", "untrusted"],
    ]);
    expect(list.project?.status).toBe("ok");
    expect(await refused("graph_templates_list", { projectId: "missing" })).toBe("not-found");
  });

  test("graph_template_get reads any scope and validates the ref", async () => {
    const detail = await run<GraphTemplateDetail>("graph_template_get", {
      ref: { scope: "builtin", id: "multi-review" },
    });
    expect(detail.summary.readOnly).toBe(true);
    expect(detail.template.id).toBe("multi-review");
    expect(await refused("graph_template_get", { ref: { scope: "user", id: "Not An Id" } })).toBe(
      "invalid-request",
    );
    expect(
      await refused("graph_template_get", {
        ref: { scope: "project", projectId: fixture.projectId, path: "../escape.graph.json" },
      }),
    ).toBe("invalid-request");
    expect(await refused("graph_template_get", { ref: { scope: "user", id: "absent" } })).toBe(
      "not-found",
    );
  });

  test("graph_template_save compare-and-swaps on revision", async () => {
    const created = await run<GraphTemplateDetail>("graph_template_save", {
      template: sampleGraphTemplate("mine"),
    });
    expect(created.summary.revision).toBe(1);
    await run("graph_template_save", { template: created.template, expectedRevision: 1 });
    expect(
      await refused("graph_template_save", { template: created.template, expectedRevision: 1 }),
    ).toBe("revision-conflict");
    expect(
      await refused("graph_template_save", { template: created.template, expectedRevision: -1 }),
    ).toBe("invalid-request");
    expect(await refused("graph_template_save", {})).toBe("invalid-request");
    expect(await refused("graph_template_save", { template: { id: "x" } })).toBe(
      "invalid-template",
    );
  });

  test("graph_template_delete removes a user template", async () => {
    await run("graph_template_save", { template: sampleGraphTemplate("mine") });
    expect(await refused("graph_template_delete", { id: "mine", expectedRevision: 9 })).toBe(
      "revision-conflict",
    );
    expect(await run("graph_template_delete", { id: "mine", expectedRevision: 1 })).toEqual({
      deleted: true,
    });
    expect(await run("graph_template_delete", { id: "mine" })).toEqual({ deleted: false });
    expect(await refused("graph_template_delete", {})).toBe("invalid-request");
  });

  test("graph_template_duplicate copies into a new user template", async () => {
    const copy = await run<GraphTemplateDetail>("graph_template_duplicate", {
      ref: { scope: "builtin", id: "multi-review" },
      id: "my-review",
      name: "My review",
    });
    expect(copy.summary).toMatchObject({ scope: "user", id: "my-review", revision: 1 });
    expect(copy.template.name).toBe("My review");
    expect(
      await refused("graph_template_duplicate", {
        ref: { scope: "builtin", id: "multi-review" },
        id: "Bad Id",
      }),
    ).toBe("invalid-request");
  });

  test("graph_template_compile uses the project's ceiling and gates launches on trust", async () => {
    await run("graph_template_save", { template: pushingGraphTemplate("pusher") });
    const pushing = await run<GraphTemplateCompileResponse>("graph_template_compile", {
      ref: { scope: "user", id: "pusher" },
    });
    expect(
      pushing.diagnostics.some((diagnostic) => diagnostic.code === "capability-remote-write"),
    ).toBe(true);
    await run("graph_capability_ceiling_set", {
      projectId: fixture.projectId,
      ceiling: { deny: ["network"] },
    });
    const draft = await run<GraphTemplateCompileResponse>("graph_template_compile", {
      template: sampleGraphTemplate("draft"),
      projectId: fixture.projectId,
      includePlan: true,
    });
    expect(draft.ceiling).toEqual({ deny: ["network"] });
    expect(draft.plan?.context.ceiling).toEqual({ deny: ["network"] });

    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("repo"));
    const ref = { scope: "project", projectId: fixture.projectId, path: PATH };
    expect(await refused("graph_template_compile", { ref, forLaunch: true })).toBe("untrusted");
    expect(await refused("graph_template_compile", {})).toBe("invalid-request");
    expect(await refused("graph_template_compile", { ref, template: sampleGraphTemplate() })).toBe(
      "invalid-request",
    );
    expect(await refused("graph_template_compile", { ref, includePlan: "yes" })).toBe(
      "invalid-request",
    );
  });

  test("graph_template_import and graph_template_export round-trip canonical JSON", async () => {
    const imported = await run<GraphTemplateImportResult>("graph_template_import", {
      text: JSON.stringify(sampleGraphTemplate("imported")),
    });
    expect(imported.ok).toBe(true);
    const exported = await run<GraphTemplateExport>("graph_template_export", {
      ref: { scope: "user", id: "imported" },
    });
    expect(exported.fileName).toBe("imported.graph.json");
    const again = await run<GraphTemplateImportResult>("graph_template_import", {
      text: exported.text,
    });
    expect(again).toMatchObject({ ok: true, renamedFrom: "imported" });
    const duplicateKeys = await run<GraphTemplateImportResult>("graph_template_import", {
      text: '{"id":"a","id":"b"}',
    });
    expect(duplicateKeys.ok).toBe(false);
    expect(await refused("graph_template_import", { text: 5 })).toBe("invalid-request");
  });

  test("graph_template_trust approves a reviewed digest and revokes", async () => {
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("repo"));
    const ref = { scope: "project", projectId: fixture.projectId, path: PATH };
    const { summary } = await run<GraphTemplateDetail>("graph_template_get", { ref });
    expect(
      await refused("graph_template_trust", {
        projectId: fixture.projectId,
        path: PATH,
        action: "approve",
      }),
    ).toBe("invalid-request");
    const approved = await run<GraphTemplateTrustResult>("graph_template_trust", {
      projectId: fixture.projectId,
      path: PATH,
      action: "approve",
      digest: summary.digest,
    });
    expect(approved.trust).toBe("trusted");
    const launch = await run<GraphTemplateCompileResponse>("graph_template_compile", {
      ref,
      forLaunch: true,
    });
    expect(launch.launchable).toBe(true);
    const revoked = await run<GraphTemplateTrustResult>("graph_template_trust", {
      projectId: fixture.projectId,
      path: PATH,
      action: "revoke",
    });
    expect(revoked.trust).toBe("untrusted");
    expect(
      await refused("graph_template_trust", {
        projectId: fixture.projectId,
        path: PATH,
        action: "allow",
      }),
    ).toBe("invalid-request");
    expect(
      await refused("graph_template_trust", {
        projectId: fixture.projectId,
        path: "README.md",
        action: "revoke",
      }),
    ).toBe("invalid-request");
  });

  test("graph_capability_ceiling_get and _set", async () => {
    const initial = await run<GraphProjectCeiling>("graph_capability_ceiling_get", {
      projectId: fixture.projectId,
    });
    expect(initial).toMatchObject({ isDefault: true, revision: 0 });
    const set = await run<GraphProjectCeiling>("graph_capability_ceiling_set", {
      projectId: fixture.projectId,
      ceiling: { deny: ["network"], allow: ["web.search"] },
      expectedRevision: 0,
    });
    expect(set).toMatchObject({
      ceiling: { deny: ["network"], allow: ["web.search"] },
      isDefault: false,
      revision: 1,
    });
    expect(
      await refused("graph_capability_ceiling_set", {
        projectId: fixture.projectId,
        ceiling: { deny: ["git.push"] },
      }),
    ).toBe("invalid-ceiling");
    expect(
      await refused("graph_capability_ceiling_set", {
        projectId: fixture.projectId,
        ceiling: null,
        expectedRevision: 0,
      }),
    ).toBe("revision-conflict");
    expect(
      await run<GraphProjectCeiling>("graph_capability_ceiling_set", {
        projectId: fixture.projectId,
        ceiling: null,
      }),
    ).toMatchObject({ isDefault: true, revision: 2 });
    expect(await refused("graph_capability_ceiling_set", { projectId: fixture.projectId })).toBe(
      "invalid-request",
    );
    expect(await refused("graph_capability_ceiling_get", {})).toBe("invalid-request");
  });
});
