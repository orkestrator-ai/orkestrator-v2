import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  GRAPH_SHARING_BOUNDS,
  encodeGraphBase64Url,
  graphSharingKeyId,
  type GraphTemplateShareImportResult,
} from "@orkestrator/protocol/graphs/sharing";
import { GraphTemplateError } from "./graph-template-errors.js";
import { generateGraphSharingKeyPair } from "./graph-template-signing.js";
import {
  createGraphTemplateFixture,
  pushingGraphTemplate,
  sampleGraphTemplate,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";

let fixture: GraphTemplateFixture;

beforeEach(async () => {
  fixture = await createGraphTemplateFixture({
    builtins: () => [{ ...graphTemplateExample("multi-review"), engine: "multi-review" }],
  });
});

afterEach(async () => {
  await fixture.close();
});

async function rejection(promise: Promise<unknown>): Promise<GraphTemplateError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphTemplateError);
    return error as GraphTemplateError;
  }
  throw new Error("Expected a GraphTemplateError");
}

function preview(result: GraphTemplateShareImportResult) {
  if (result.status !== "preview") throw new Error(`Expected a preview, got ${result.status}`);
  return result.preview;
}

function refused(result: GraphTemplateShareImportResult) {
  if (result.status !== "refused") throw new Error(`Expected a refusal, got ${result.status}`);
  return result;
}

const PATH = ".orkestrator/graphs/review.graph.json";

/** Edits the bundle text's JSON and writes it back. */
function edit(text: string, mutate: (bundle: Record<string, any>) => void): string {
  const bundle = JSON.parse(text);
  mutate(bundle);
  return JSON.stringify(bundle);
}

describe("share bundles", () => {
  test("round trip: export, preview, confirm, import", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("shared"));
    const exported = await service.sharing.exportBundle(
      { scope: "user", id: "shared" },
      { author: "Ada" },
    );
    expect(exported).toMatchObject({ fileName: "shared.graph-bundle.json", signed: false });
    const before = (await service.list()).templates.length;

    const shown = preview(await service.sharing.importShared(exported.text));
    expect(shown).toMatchObject({
      kind: "bundle",
      integrity: "unsigned",
      digest: exported.digest,
      templateId: "shared",
      renameTo: "shared-2",
      author: "Ada",
      engineDropped: false,
    });
    expect(shown.compile.ok).toBe(true);
    expect(shown.capabilities.agentNodes).toBeGreaterThan(0);
    // A preview saves nothing.
    expect((await service.list()).templates).toHaveLength(before);

    const imported = await service.sharing.importShared(exported.text, {
      confirmDigest: exported.digest,
    });
    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") return;
    expect(imported.renamedFrom).toBe("shared");
    expect(imported.detail.summary).toMatchObject({
      scope: "user",
      id: "shared-2",
      trust: "trusted",
    });
    expect(imported.detail.template.nodes).toEqual(sampleGraphTemplate("shared").nodes);
  });

  test("confirming another digest is refused and saves nothing", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("shared"));
    const exported = await service.sharing.exportBundle({ scope: "user", id: "shared" });
    const error = await rejection(
      service.sharing.importShared(exported.text, { confirmDigest: "0".repeat(64) }),
    );
    expect(error.code).toBe("digest-mismatch");
    expect((await service.list()).templates.filter((entry) => entry.scope === "user")).toHaveLength(
      1,
    );
  });

  test("a tampered template is refused by its digest, signed or not", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("shared"));
    for (const sign of [false, true]) {
      const exported = await service.sharing.exportBundle(
        { scope: "user", id: "shared" },
        { sign },
      );
      const tampered = edit(exported.text, (bundle) => {
        bundle.template.description = "Now pushes to main";
      });
      const result = refused(
        await service.sharing.importShared(tampered, { confirmDigest: exported.digest }),
      );
      expect(result.refused).toBe("digest-mismatch");
    }
    expect((await service.list()).templates.filter((entry) => entry.scope === "user")).toHaveLength(
      1,
    );
  });

  test("a tampered signed bundle whose digests were recomputed is refused by its signature", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("shared"));
    await service.save(pushingGraphTemplate("evil"));
    const good = await service.sharing.exportBundle(
      { scope: "user", id: "shared" },
      { sign: true },
    );
    // An attacker swaps in another template with consistent digests but keeps the signature.
    const evil = JSON.parse(
      (await service.sharing.exportBundle({ scope: "user", id: "evil" })).text,
    );
    const forged = edit(good.text, (bundle) => {
      bundle.template = evil.template;
      bundle.digest = evil.digest;
      bundle.contentDigest = evil.contentDigest;
    });
    const result = refused(await service.sharing.importShared(forged));
    expect(result.refused).toBe("signature-invalid");
    // Changing only the metadata breaks the signature too.
    const relabelled = edit(good.text, (bundle) => {
      bundle.author = "Someone else";
    });
    expect(refused(await service.sharing.importShared(relabelled)).refused).toBe(
      "signature-invalid",
    );
    // Re-signing with another key under the original key id is caught by the key id check.
    const other = generateGraphSharingKeyPair(new Date());
    const swapped = edit(good.text, (bundle) => {
      bundle.signature.publicKey = other.publicKey;
    });
    expect(refused(await service.sharing.importShared(swapped)).refused).toBe("signature-invalid");
  });

  test("signer states: own key, unknown key, trusted key", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("shared"));
    const signed = await service.sharing.exportBundle(
      { scope: "user", id: "shared" },
      { sign: true },
    );
    expect(signed.signed).toBe(true);
    const keys = service.sharing.keys();
    expect(keys.installation?.keyId).toBe(signed.keyId!);
    expect(JSON.stringify(keys)).not.toContain("privateKey");

    // Our own key reads as trusted ("This installation").
    const own = preview(await service.sharing.importShared(signed.text));
    expect(own).toMatchObject({ integrity: "trusted-signer", signer: { own: true } });

    // Another installation's key is unknown until trusted.
    const stranger = await createGraphTemplateFixture({ builtins: () => [] });
    try {
      const theirs = preview(await stranger.service.sharing.importShared(signed.text));
      expect(theirs.integrity).toBe("untrusted-signer");
      expect(theirs.signer).toMatchObject({ keyId: signed.keyId });
      expect(theirs.signer?.label).toBeUndefined();
      stranger.service.sharing.trustKey({
        action: "add",
        publicKey: theirs.signer!.publicKey,
        label: "Ada's laptop",
      });
      const trusted = preview(await stranger.service.sharing.importShared(signed.text));
      expect(trusted).toMatchObject({
        integrity: "trusted-signer",
        signer: { label: "Ada's laptop" },
      });
      const removed = stranger.service.sharing.trustKey({
        action: "remove",
        publicKey: theirs.signer!.publicKey,
      });
      expect(removed.trusted).toEqual([]);
    } finally {
      await stranger.close();
    }
  });

  test("a plain template is previewed without a digest to check", async () => {
    const { service } = fixture;
    const text = JSON.stringify(sampleGraphTemplate("plain"));
    const shown = preview(await service.sharing.importShared(text));
    expect(shown).toMatchObject({ kind: "template", integrity: "no-digest", templateId: "plain" });
    const imported = await service.sharing.importShared(text, { confirmDigest: shown.digest });
    expect(imported.status).toBe("imported");
  });

  test("a built-in's bundle imports without its engine", async () => {
    const { service } = fixture;
    const exported = await service.sharing.exportBundle({ scope: "builtin", id: "multi-review" });
    const shown = preview(await service.sharing.importShared(exported.text));
    expect(shown.engineDropped).toBe(true);
    const imported = await service.sharing.importShared(exported.text, {
      confirmDigest: shown.digest,
    });
    expect(imported.status === "imported" && imported.detail.template.engine).toBeUndefined();
  });

  test("the preview's capability summary uses the project ceiling and shows refused pushes", async () => {
    const { service, projectId } = fixture;
    await service.save(pushingGraphTemplate("evil"));
    const exported = await service.sharing.exportBundle({ scope: "user", id: "evil" });
    const shown = preview(await service.sharing.importShared(exported.text, { projectId }));
    expect(shown.compile.ok).toBe(false);
    expect(shown.capabilities.remoteWriteRequests.nodes).toEqual(["fix"]);
  });

  test("project templates are signed only while trusted", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const ref = { scope: "project" as const, projectId, path: PATH };
    expect((await rejection(service.sharing.exportBundle(ref, { sign: true }))).code).toBe(
      "untrusted",
    );
    // Unsigned export is fine: the importer reviews it.
    expect((await service.sharing.exportBundle(ref)).signed).toBe(false);
    const { summary } = await service.get(ref);
    await service.trust({ projectId, path: PATH, action: "approve", digest: summary.digest });
    expect((await service.sharing.exportBundle(ref, { sign: true })).signed).toBe(true);
  });

  test("the installation key is created once", async () => {
    const { service } = fixture;
    expect(service.sharing.keys().installation).toBeNull();
    const created = service.sharing.keys({ create: true }).installation;
    expect(created?.keyId).toBe(graphSharingKeyId(created!.publicKey));
    expect(service.sharing.keys({ create: true }).installation).toEqual(created);
  });

  test("trusted keys are validated and bounded", () => {
    const { service } = fixture;
    expect(() =>
      service.sharing.trustKey({ action: "add", publicKey: "nope", label: "x" }),
    ).toThrow(GraphTemplateError);
    const key = (index: number) =>
      encodeGraphBase64Url(new Uint8Array(32).map((_, at) => (at === 0 ? index : 7)));
    expect(() =>
      service.sharing.trustKey({ action: "add", publicKey: key(0), label: "two\nlines" }),
    ).toThrow(GraphTemplateError);
    for (let index = 0; index < GRAPH_SHARING_BOUNDS.maxTrustedKeys; index += 1) {
      service.sharing.trustKey({ action: "add", publicKey: key(index), label: `Key ${index}` });
    }
    // Relabelling an existing key is not a new one.
    service.sharing.trustKey({ action: "add", publicKey: key(0), label: "Renamed" });
    expect(service.sharing.keys().trusted).toHaveLength(GRAPH_SHARING_BOUNDS.maxTrustedKeys);
    try {
      service.sharing.trustKey({ action: "add", publicKey: key(200), label: "One too many" });
      throw new Error("Expected a limit");
    } catch (error) {
      expect((error as GraphTemplateError).code).toBe("limit");
    }
  });

  test("nothing logs template content, bundle text or keys", async () => {
    const { service } = fixture;
    const spies = [
      spyOn(console, "log"),
      spyOn(console, "info"),
      spyOn(console, "warn"),
      spyOn(console, "error"),
      spyOn(console, "debug"),
    ];
    try {
      await service.save(sampleGraphTemplate("shared"));
      const exported = await service.sharing.exportBundle(
        { scope: "user", id: "shared" },
        { sign: true },
      );
      await service.sharing.importShared(exported.text, { confirmDigest: exported.digest });
      await service.sharing.importShared(edit(exported.text, (bundle) => (bundle.author = "x")));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("project template review", () => {
  test("lists untrusted templates with a capability summary and no diff", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const review = await service.sharing.review(projectId);
    expect(review.source).toMatchObject({ projectId, status: "ok" });
    expect(review.items).toHaveLength(1);
    const [item] = review.items;
    expect(item).toMatchObject({
      path: PATH,
      templateId: "from-repo",
      trust: "untrusted",
      diff: null,
      diffUnavailable: "never-approved",
    });
    expect(item!.capabilities.compiled).toBe(true);
    expect(item!.capabilities.profiles.length).toBeGreaterThan(0);
  });

  test("a changed template shows a diff against the approved copy; approving resets trust", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const first = (await service.sharing.review(projectId)).items[0]!;
    const approved = await service.sharing.decide({
      projectId,
      path: PATH,
      digest: first.digest,
      decision: "approve",
    });
    expect(approved).toMatchObject({ decision: "approve", trust: "trusted" });
    // Trusted templates are not listed.
    expect((await service.sharing.review(projectId)).items).toEqual([]);

    await fixture.writeProjectTemplate("review.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      description: "Now with network",
    });
    const changed = (await service.sharing.review(projectId)).items[0]!;
    expect(changed).toMatchObject({
      trust: "changed",
      approvedDigest: first.digest,
      approvedAt: approved.decidedAt,
    });
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.diff).toMatchObject({
      fromDigest: first.digest,
      additions: 1,
      truncated: false,
    });
    const added = changed.diff!.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.type === "add").map((line) => line.text),
    );
    expect(added.join("")).toContain("Now with network");

    // A stale approval is refused; the reviewed one resets trust.
    expect(
      (
        await rejection(
          service.sharing.decide({
            projectId,
            path: PATH,
            digest: first.digest,
            decision: "approve",
          }),
        )
      ).code,
    ).toBe("digest-mismatch");
    await service.sharing.decide({
      projectId,
      path: PATH,
      digest: changed.digest,
      decision: "approve",
    });
    expect((await service.get({ scope: "project", projectId, path: PATH })).summary.trust).toBe(
      "trusted",
    );
    expect((await service.sharing.review(projectId)).items).toEqual([]);
    // The new approval is the next diff's baseline.
    await fixture.writeProjectTemplate("review.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      description: "Third version",
    });
    const third = (await service.sharing.review(projectId)).items[0]!;
    expect(third.diff?.fromDigest).toBe(changed.digest);
  });

  test("rejecting keeps it untrusted, files it under rejected and keeps the earlier approval", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const original = (await service.sharing.review(projectId)).items[0]!;
    await service.sharing.decide({
      projectId,
      path: PATH,
      digest: original.digest,
      decision: "approve",
    });
    await fixture.writeProjectTemplate("review.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      description: "Sneaky",
    });
    await fixture.writeProjectTemplate("other.graph.json", sampleGraphTemplate("other"));
    const changed = (await service.sharing.review(projectId, PATH)).items[0]!;
    const rejected = await service.sharing.decide({
      projectId,
      path: PATH,
      digest: changed.digest,
      decision: "reject",
    });
    expect(rejected).toMatchObject({ decision: "reject", trust: "changed" });
    const review = await service.sharing.review(projectId);
    // Needing review first, rejected after.
    expect(review.items.map((item) => [item.path, item.rejectedAt !== undefined])).toEqual([
      [".orkestrator/graphs/other.graph.json", false],
      [PATH, true],
    ]);
    // The diff still has its baseline.
    expect(review.items[1]!.diff?.fromDigest).toBe(original.digest);
    // Reverting the file to the approved content is trusted again.
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    expect((await service.get({ scope: "project", projectId, path: PATH })).summary.trust).toBe(
      "trusted",
    );
    // A stale rejection is refused.
    expect(
      (
        await rejection(
          service.sharing.decide({
            projectId,
            path: PATH,
            digest: changed.digest,
            decision: "reject",
          }),
        )
      ).code,
    ).toBe("digest-mismatch");
  });

  test("revoking drops the approved copy; project removal drops the approvals row", async () => {
    const { service, projectId, storage } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const item = (await service.sharing.review(projectId)).items[0]!;
    await service.sharing.decide({
      projectId,
      path: PATH,
      digest: item.digest,
      decision: "approve",
    });
    expect(
      storage.graphTemplates.getGraphProjectApprovals(projectId)?.approved[PATH]?.text,
    ).toContain('"id": "from-repo"');
    await service.trust({ projectId, path: PATH, action: "revoke" });
    expect(storage.graphTemplates.getGraphProjectApprovals(projectId)?.approved[PATH]).toBe(
      undefined,
    );
    await service.sharing.decide({
      projectId,
      path: PATH,
      digest: item.digest,
      decision: "reject",
    });
    expect(storage.graphTemplates.getGraphProjectApprovals(projectId)).not.toBeNull();
    await storage.removeProject(projectId);
    expect(storage.graphTemplates.getGraphProjectApprovals(projectId)).toBeNull();
  });

  test("approved copies are bounded: too large or over the project budget, the text is dropped", async () => {
    const { service, projectId, storage } = fixture;
    // One copy over the per-template bound keeps the digest only.
    const template = sampleGraphTemplate("from-repo");
    await fixture.writeProjectTemplate("review.graph.json", template);
    const file = (await service.projectTemplates.scan(projectId)).files[0]!;
    storage.graphTemplates.approveGraphProjectTemplate(
      projectId,
      { path: PATH, digest: file.digest, approvedAt: "2026-10-29T00:00:00.000Z" },
      new Set([PATH]),
      "y".repeat(GRAPH_SHARING_BOUNDS.maxApprovedTextBytes + 1),
    );
    expect(storage.graphTemplates.getGraphProjectApprovals(projectId)?.approved[PATH]).toEqual({
      digest: file.digest,
      approvedAt: "2026-10-29T00:00:00.000Z",
      textOmitted: "too-large",
    });
    await fixture.writeProjectTemplate(
      "review.graph.json",
      sampleGraphTemplate("from-repo", { description: "Changed" }),
    );
    expect((await service.sharing.review(projectId)).items[0]).toMatchObject({
      trust: "changed",
      diff: null,
      diffUnavailable: "too-large",
    });

    // Over the project budget, the oldest approvals lose their text first.
    const perCopy = GRAPH_SHARING_BOUNDS.maxApprovedTextBytes;
    const count = Math.ceil(GRAPH_SHARING_BOUNDS.maxApprovedTextBytesPerProject / perCopy) + 2;
    const paths = Array.from(
      { length: count },
      (_, index) => `.orkestrator/graphs/t${index}.graph.json`,
    );
    for (const [index, path] of paths.entries()) {
      storage.graphTemplates.approveGraphProjectTemplate(
        projectId,
        {
          path,
          digest: String(index).padStart(64, "0"),
          approvedAt: `2026-10-29T00:00:${String(index).padStart(2, "0")}.000Z`,
        },
        new Set(paths),
        "z".repeat(perCopy),
      );
    }
    const approved = storage.graphTemplates.getGraphProjectApprovals(projectId)!.approved;
    const kept = paths.filter((path) => approved[path]?.text !== undefined);
    expect(kept.length * perCopy).toBeLessThanOrEqual(
      GRAPH_SHARING_BOUNDS.maxApprovedTextBytesPerProject,
    );
    expect(approved[paths[0]!]?.textOmitted).toBe("budget");
    expect(approved[paths.at(-1)!]?.text).toBeDefined();
    // Paths outside keepPaths were pruned (the original PATH).
    expect(approved[PATH]).toBeUndefined();
  });
});
