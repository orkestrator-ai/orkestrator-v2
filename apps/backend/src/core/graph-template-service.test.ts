import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { GraphTemplateError } from "./graph-template-errors.js";
import {
  createGraphTemplateFixture,
  pushingGraphTemplate,
  recordGraphTemplateChanges,
  sampleGraphTemplate,
  waitForGraphCondition,
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

const PATH = ".orkestrator/graphs/review.graph.json";

describe("scopes", () => {
  test("lists built-in, user and project templates with scope, trust, revision and compile summary", async () => {
    const { service, projectId } = fixture;
    await service.save(sampleGraphTemplate("mine"));
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const list = await service.list({ projectId });
    expect(
      list.templates.map((entry) => [
        entry.scope,
        entry.id,
        entry.trust,
        entry.revision,
        entry.readOnly,
      ]),
    ).toEqual([
      ["builtin", "multi-review", "trusted", 1, true],
      ["user", "mine", "trusted", 1, false],
      ["project", "from-repo", "untrusted", 0, true],
    ]);
    const [builtin, user, project] = list.templates;
    expect(builtin?.engine).toBe("multi-review");
    expect(user?.compile).toMatchObject({ ok: true, launchable: true, errors: 0 });
    expect(user?.compile.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(user?.compile.cost?.agentSessions.worst).toBeGreaterThan(0);
    expect(user?.launchable).toBe(true);
    // Compiles, but untrusted: listed, not launchable.
    expect(project?.compile.launchable).toBe(true);
    expect(project?.launchable).toBe(false);
    expect(project?.ref).toEqual({ scope: "project", projectId, path: PATH });
    expect(list.project).toMatchObject({ projectId, status: "ok", files: 1, truncated: false });
    expect(list.ceiling).toEqual({ deny: [] });
    // Without a project only built-in and user templates are listed.
    expect((await service.list()).templates.map((entry) => entry.scope)).toEqual([
      "builtin",
      "user",
    ]);
  });

  test("built-ins are read-only but duplicable into a user template without their engine", async () => {
    const { service } = fixture;
    const copy = await service.duplicate({ scope: "builtin", id: "multi-review" });
    expect(copy.summary).toMatchObject({
      scope: "user",
      id: "multi-review-copy",
      revision: 1,
      readOnly: false,
    });
    expect(copy.template.engine).toBeUndefined();
    expect(copy.template.name).toBe(`${graphTemplateExample("multi-review").name} (copy)`);
    const again = await service.duplicate(
      { scope: "builtin", id: "multi-review" },
      { name: "Mine" },
    );
    expect(again.summary.id).toBe("multi-review-copy-2");
    expect(again.template.name).toBe("Mine");
    expect(
      (
        await rejection(
          service.duplicate({ scope: "builtin", id: "multi-review" }, { id: "multi-review-copy" }),
        )
      ).code,
    ).toBe("revision-conflict");
    expect((await rejection(service.save({ ...copy.template, engine: "multi-review" }))).code).toBe(
      "invalid-template",
    );
    expect((await rejection(service.get({ scope: "builtin", id: "nope" }))).code).toBe("not-found");
  });

  test("an invalid built-in is skipped, never listed", async () => {
    await fixture.close();
    fixture = await createGraphTemplateFixture({
      builtins: () => [{ ...sampleGraphTemplate("ok") }, { id: "broken" } as never],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await fixture.service.list()).templates.map((entry) => entry.id)).toEqual(["ok"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("user templates", () => {
  test("save compare-and-swaps on the template's revision", async () => {
    const { service } = fixture;
    const created = await service.save(sampleGraphTemplate("mine"));
    expect(created.summary.revision).toBe(1);
    expect(created.template.revision).toBe(1);
    const updated = await service.save({ ...created.template, name: "Second" });
    expect(updated.summary.revision).toBe(2);
    // A second editor still holding revision 1 conflicts.
    const stale = await rejection(service.save({ ...created.template, name: "Stale" }));
    expect(stale.code).toBe("revision-conflict");
    expect((await service.get({ scope: "user", id: "mine" })).template.name).toBe("Second");
    // An explicit expected revision wins over the template's own field.
    expect(
      (await service.save({ ...created.template, name: "Third" }, { expectedRevision: 2 })).summary
        .revision,
    ).toBe(3);
    expect((await rejection(service.save({ id: "x" }))).code).toBe("invalid-template");
    expect((await rejection(service.delete("mine", 2))).code).toBe("revision-conflict");
    expect(await service.delete("mine", 3)).toEqual({ deleted: true });
    expect(await service.delete("mine")).toEqual({ deleted: false });
  });

  test("import validates JSON text, refuses duplicate keys and oversize text, and renames a taken id", async () => {
    const { service } = fixture;
    const text = JSON.stringify(sampleGraphTemplate("imported"));
    const first = await service.importText(text);
    expect(first.ok && first.detail.summary).toMatchObject({
      scope: "user",
      id: "imported",
      revision: 1,
    });
    const second = await service.importText(text);
    expect(second).toMatchObject({ ok: true, renamedFrom: "imported" });
    expect(second.ok && second.detail.summary.id).toBe("imported-2");

    const duplicateKeys = await service.importText('{"format":"orkestrator.graph","format":"x"}');
    expect(duplicateKeys).toMatchObject({ ok: false, errors: [{ code: "invalid_json" }] });
    const oversize = await service.importText(" ".repeat(1024 * 1024 + 1));
    expect(oversize).toMatchObject({ ok: false, errors: [{ code: "too_large" }] });
    const invalid = await service.importText(
      JSON.stringify({ ...sampleGraphTemplate("bad"), nodes: 3 }),
    );
    expect(invalid.ok).toBe(false);
    // An exported built-in imports as a user template without its engine.
    const builtin = await service.export({ scope: "builtin", id: "multi-review" });
    const fromBuiltin = await service.importText(builtin.text);
    expect(fromBuiltin.ok && fromBuiltin.detail.template.engine).toBeUndefined();
  });

  test("export is canonical JSON whatever the key order", async () => {
    const { service } = fixture;
    const template = sampleGraphTemplate("ordered");
    const reversed = Object.fromEntries(Object.entries(template).reverse());
    await service.importText(JSON.stringify(reversed));
    const exported = await service.export({ scope: "user", id: "ordered" });
    expect(exported.fileName).toBe("ordered.graph.json");
    expect(exported.text.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(exported.text) as object);
    expect(keys).toEqual([...keys].sort());
    expect(exported.digest).toBe(graphTemplateDigest({ ...template, revision: 1 }));
    // Round trip.
    const back = await service.importText(exported.text);
    expect(back.ok && back.detail.summary.digest).not.toBe("");
  });
});

describe("trust", () => {
  test("approving needs the reviewed digest; a changed digest is untrusted again", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const ref = { scope: "project" as const, projectId, path: PATH };
    const before = await service.get(ref);
    expect(before.summary.trust).toBe("untrusted");
    expect((await rejection(service.compile({ ref }, { forLaunch: true }))).code).toBe("untrusted");
    expect(
      (
        await rejection(
          service.trust({ projectId, path: PATH, action: "approve", digest: "0".repeat(64) }),
        )
      ).code,
    ).toBe("digest-mismatch");

    const approved = await service.trust({
      projectId,
      path: PATH,
      action: "approve",
      digest: before.summary.digest,
    });
    expect(approved).toMatchObject({ trust: "trusted", digest: before.summary.digest });
    expect(approved.records).toEqual([
      { path: PATH, digest: before.summary.digest, approvedAt: expect.any(String) },
    ]);
    const trusted = await service.get(ref);
    expect(trusted.summary).toMatchObject({ trust: "trusted", launchable: true });
    const launch = await service.compileForLaunch(ref);
    expect(launch.plan?.digest).toBe(launch.planDigest!);

    // The file changes: the old approval no longer covers it.
    await fixture.writeProjectTemplate("review.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      description: "Now with network",
    });
    const changed = await service.get(ref);
    expect(changed.summary.trust).toBe("changed");
    expect(changed.summary.launchable).toBe(false);
    expect(changed.summary.digest).not.toBe(before.summary.digest);
    const blocked = await service.compile({ ref });
    expect(blocked).toMatchObject({ launchable: false, blockedBy: "changed" });
    expect((await rejection(service.compile({ ref }, { forLaunch: true }))).code).toBe("untrusted");

    await service.trust({
      projectId,
      path: PATH,
      action: "approve",
      digest: changed.summary.digest,
    });
    expect((await service.get(ref)).summary.trust).toBe("trusted");
    const revoked = await service.trust({ projectId, path: PATH, action: "revoke" });
    expect(revoked).toMatchObject({ trust: "untrusted", records: [] });
    expect((await service.get(ref)).summary.trust).toBe("untrusted");
  });

  test("an edit on disk is picked up by the watch and announced", async () => {
    const { service, projectId, storage } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const before = await service.get({ scope: "project", projectId, path: PATH });
    await service.trust({
      projectId,
      path: PATH,
      action: "approve",
      digest: before.summary.digest,
    });
    await waitForGraphCondition(() => fixture.watch.open().length === 1);
    const changes = recordGraphTemplateChanges(storage);
    await fixture.writeProjectTemplate("review.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      name: "Edited",
    });
    fixture.watch.fire();
    await waitForGraphCondition(() => changes.ids.includes(`project:${projectId}`));
    changes.stop();
    const list = await service.list({ projectId });
    expect(list.templates.at(-1)).toMatchObject({ name: "Edited", trust: "changed" });
  });

  test("an invalid project template cannot be trusted, and duplicating needs the digest", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("broken.graph.json", "{");
    expect(
      (
        await rejection(
          service.trust({
            projectId,
            path: ".orkestrator/graphs/broken.graph.json",
            action: "approve",
            digest: "0".repeat(64),
          }),
        )
      ).code,
    ).toBe("invalid-template");
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const ref = { scope: "project" as const, projectId, path: PATH };
    expect((await rejection(service.duplicate(ref))).code).toBe("digest-mismatch");
    const digest = (await service.get(ref)).summary.digest;
    const copy = await service.duplicate(ref, { digest });
    expect(copy.summary).toMatchObject({ scope: "user", id: "from-repo-copy", trust: "trusted" });
  });
});

describe("project removal", () => {
  test("drops the project's trust records and ceiling and stops its watch", async () => {
    const { service, projectId, storage } = fixture;
    await fixture.writeProjectTemplate("review.graph.json", sampleGraphTemplate("from-repo"));
    const { summary } = await service.get({ scope: "project", projectId, path: PATH });
    await service.trust({ projectId, path: PATH, action: "approve", digest: summary.digest });
    await service.setCeiling(projectId, { deny: ["network"] });
    await waitForGraphCondition(() => fixture.watch.open().length === 1);
    await storage.removeProject(projectId);
    expect(fixture.watch.open()).toEqual([]);
    expect(storage.graphTemplates.getGraphProjectSettings(projectId)).toBeNull();
    expect((await rejection(service.list({ projectId }))).code).toBe("not-found");
  });
});

describe("capability ceiling", () => {
  test("defaults to every agent capability and can be tightened per project", async () => {
    const { service, projectId } = fixture;
    expect(await service.getCeiling(projectId)).toEqual({
      projectId,
      ceiling: { deny: [] },
      isDefault: true,
      revision: 0,
    });
    const set = await service.setCeiling(projectId, { deny: ["web.search", "network"] }, 0);
    expect(set).toMatchObject({
      ceiling: { deny: ["network", "web.search"] },
      isDefault: false,
      revision: 1,
    });
    expect((await rejection(service.setCeiling(projectId, { deny: [] }, 0))).code).toBe(
      "revision-conflict",
    );
    const reset = await service.setCeiling(projectId, null, 1);
    expect(reset).toMatchObject({ isDefault: true, revision: 2, ceiling: { deny: [] } });
    expect((await rejection(service.getCeiling("missing"))).code).toBe("not-found");
  });

  test("git.push and github.write are outside the ceiling", async () => {
    const { service, projectId } = fixture;
    for (const capability of ["git.push", "github.write"]) {
      const error = await rejection(service.setCeiling(projectId, { deny: [capability] }));
      expect(error.code).toBe("invalid-ceiling");
      expect(error.message).toContain("outside the ceiling");
    }
    expect((await rejection(service.setCeiling(projectId, { deny: ["teleport"] }))).code).toBe(
      "invalid-ceiling",
    );
  });

  test("the project's ceiling narrows a template's profiles, and a template asking for push is rejected", async () => {
    const { service, projectId } = fixture;
    await service.save(sampleGraphTemplate("mine"));
    const ref = { scope: "user" as const, id: "mine" };
    const open = await service.compile({ ref }, { projectId, includePlan: true });
    const openFix = open.plan?.nodes.find((node) => node.id === "fix");
    expect(openFix?.kind === "agent" && openFix.capabilities.removedByCeiling).toEqual([]);

    await service.setCeiling(projectId, { deny: ["network"] });
    const narrowed = await service.compile({ ref }, { projectId, includePlan: true });
    expect(narrowed.ceiling).toEqual({ deny: ["network"] });
    expect(narrowed.planDigest).not.toBe(open.planDigest);
    const fix = narrowed.plan?.nodes.find((node) => node.id === "fix");
    expect(fix?.kind === "agent" && fix.capabilities.removedByCeiling).toContain("network");
    expect(fix?.kind === "agent" && fix.capabilities.policy.capabilityPolicy?.deny).toContain(
      "network",
    );
    // The list's compile summaries use the same ceiling.
    const listed = (await service.list({ projectId })).templates.find(
      (entry) => entry.id === "mine",
    );
    expect(listed?.compile.planDigest).toBe(narrowed.planDigest);

    await service.save(pushingGraphTemplate("pusher"));
    const pushing = await service.compile({ ref: { scope: "user", id: "pusher" } }, { projectId });
    expect(pushing.ok).toBe(false);
    expect(pushing.launchable).toBe(false);
    expect(pushing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "capability-remote-write",
        nodeId: "fix",
        severity: "error",
      }),
    );
  });

  test("compiles an unsaved draft but never for a launch", async () => {
    const { service, projectId } = fixture;
    const draft = await service.compile({ template: sampleGraphTemplate("draft") }, { projectId });
    expect(draft).toMatchObject({ summary: null, ok: true, launchable: true });
    expect(draft.plan).toBeUndefined();
    const garbage = await service.compile({ template: { nope: true } });
    expect(garbage.ok).toBe(false);
    expect(garbage.diagnostics[0]?.code).toBe("template-invalid");
    expect(
      (await rejection(service.compile({ template: sampleGraphTemplate() }, { forLaunch: true })))
        .code,
    ).toBe("invalid-request");
  });
});
