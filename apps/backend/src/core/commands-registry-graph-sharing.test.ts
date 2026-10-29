import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  GraphProjectTemplateReview,
  GraphProjectTemplateReviewDecision,
  GraphSharingKeys,
  GraphTemplateShareExport,
  GraphTemplateShareImportResult,
} from "@orkestrator/protocol/graphs/sharing";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  createGraphTemplateFixture,
  sampleGraphTemplate,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";

let fixture: GraphTemplateFixture;
let context: CommandContext;
const commands = createCommandRegistry();

beforeEach(async () => {
  fixture = await createGraphTemplateFixture();
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

describe("graph sharing commands", () => {
  test("are registered through createCommandRegistry", () => {
    for (const name of [
      "graph_template_share_export",
      "graph_template_share_import",
      "graph_sharing_keys",
      "graph_sharing_key_trust",
      "graph_project_template_review",
      "graph_project_template_review_decide",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("export, preview and confirmed import", async () => {
    await fixture.service.save(sampleGraphTemplate("shared"));
    const exported = await run<GraphTemplateShareExport>("graph_template_share_export", {
      ref: { scope: "user", id: "shared" },
      sign: true,
      author: "Ada",
    });
    expect(exported.signed).toBe(true);
    const preview = await run<GraphTemplateShareImportResult>("graph_template_share_import", {
      text: exported.text,
    });
    expect(preview.status).toBe("preview");
    const imported = await run<GraphTemplateShareImportResult>("graph_template_share_import", {
      text: exported.text,
      projectId: fixture.projectId,
      confirmDigest: exported.digest,
    });
    expect(imported.status).toBe("imported");
    const tampered = await run<GraphTemplateShareImportResult>("graph_template_share_import", {
      text: exported.text.replace('"Ada"', '"Eve"'),
    });
    expect(tampered).toMatchObject({ status: "refused", refused: "signature-invalid" });
  });

  test("keys and trust", async () => {
    const created = await run<GraphSharingKeys>("graph_sharing_keys", { create: true });
    const publicKey = created.installation!.publicKey;
    const trusted = await run<GraphSharingKeys>("graph_sharing_key_trust", {
      action: "add",
      publicKey,
      label: "Me",
    });
    expect(trusted.trusted.map((key) => key.label)).toEqual(["Me"]);
    const removed = await run<GraphSharingKeys>("graph_sharing_key_trust", {
      action: "remove",
      publicKey,
    });
    expect(removed.trusted).toEqual([]);
  });

  test("review and decide", async () => {
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const review = await run<GraphProjectTemplateReview>("graph_project_template_review", {
      projectId: fixture.projectId,
    });
    expect(review.items).toHaveLength(1);
    const decision = await run<GraphProjectTemplateReviewDecision>(
      "graph_project_template_review_decide",
      {
        projectId: fixture.projectId,
        path: PATH,
        digest: review.items[0]!.digest,
        decision: "approve",
      },
    );
    expect(decision.trust).toBe("trusted");
  });

  test("refuse malformed arguments", async () => {
    expect(await refused("graph_template_share_export", { ref: { scope: "user" } })).toBe(
      "invalid-request",
    );
    expect(
      await refused("graph_template_share_export", {
        ref: { scope: "user", id: "x" },
        sign: "yes",
      }),
    ).toBe("invalid-request");
    expect(
      await refused("graph_template_share_export", {
        ref: { scope: "user", id: "x" },
        author: "a\nb",
      }),
    ).toBe("invalid-request");
    expect(await refused("graph_template_share_import", { text: 1 })).toBe("invalid-request");
    expect(await refused("graph_template_share_import", { text: "{}", confirmDigest: "abc" })).toBe(
      "invalid-request",
    );
    expect(await refused("graph_template_share_import", { text: "{}", extra: true })).toBe(
      "invalid-request",
    );
    expect(await refused("graph_sharing_key_trust", { action: "add", publicKey: "x" })).toBe(
      "invalid-request",
    );
    expect(
      await refused("graph_sharing_key_trust", { action: "add", publicKey: "x", label: "y" }),
    ).toBe("invalid-request");
    expect(await refused("graph_project_template_review", {})).toBe("invalid-request");
    expect(
      await refused("graph_project_template_review_decide", {
        projectId: fixture.projectId,
        path: PATH,
        digest: "0".repeat(64),
        decision: "maybe",
      }),
    ).toBe("invalid-request");
    expect(
      await refused("graph_project_template_review_decide", {
        projectId: fixture.projectId,
        path: PATH,
        digest: "0".repeat(64),
        decision: "reject",
      }),
    ).toBe("not-found");
  });
});
