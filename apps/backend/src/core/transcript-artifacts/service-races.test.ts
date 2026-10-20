import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  CONVERSATION,
  ENV,
  TAB,
  createHarness,
  key,
  settle,
  type Harness,
} from "./service-test-support.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  h.runner.release();
  await h.close();
});

const staticDraft = (html = "<p>v1</p>") => ({
  title: "Doc",
  summary: "",
  payload: { kind: "html-static", html },
});

async function create(html?: string): Promise<string> {
  const created = await h.call("create_artifact", { requestKey: key(), draft: staticDraft(html) });
  expect(created.isError).toBe(false);
  return created.artifactId;
}

async function verified(artifactId: string, revision: number): Promise<string> {
  const preview = await h.call("preview_artifact", { requestKey: key(), artifactId, revision });
  const operation = await settle(h, preview.operationId);
  expect(operation.operation.status).toBe("succeeded");
  return operation.operation.receiptId;
}

describe("idempotency", () => {
  test("same key and arguments replay; different arguments conflict", async () => {
    const requestKey = key();
    const first = await h.call("create_artifact", { requestKey, draft: staticDraft() });
    const replay = await h.call("create_artifact", { requestKey, draft: staticDraft() });
    expect(replay.artifactId).toBe(first.artifactId);
    expect(replay.replayed).toBe(true);
    const conflict = await h.call("create_artifact", {
      requestKey,
      draft: staticDraft("<p>other</p>"),
    });
    expect(conflict.error.code).toBe("idempotency_conflict");
    // Grants are credentials, not semantics: excluded from the digest.
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: TAB.projectId,
      conversationKey: CONVERSATION,
      turnId: "t1",
    });
    const withGrant = await h.call("create_artifact", {
      requestKey,
      draft: staticDraft(),
      scopeCapability: grant.grant,
    });
    expect(withGrant.artifactId).toBe(first.artifactId);
    expect(JSON.stringify(withGrant)).not.toContain(grant.grant);
  });

  test("a lost publish response retried with its key returns the same reference without a second entry", async () => {
    const artifactId = await create();
    const receiptId = await verified(artifactId, 1);
    const requestKey = key();
    const first = await h.call("publish_artifact", {
      requestKey,
      artifactId,
      expectedRevision: 1,
      receiptId,
    });
    const retry = await h.call("publish_artifact", {
      requestKey,
      artifactId,
      expectedRevision: 1,
      receiptId,
    });
    const otherKey = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      receiptId,
    });
    expect(retry.publicationId).toBe(first.publicationId);
    expect(otherKey.publicationId).toBe(first.publicationId);
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toHaveLength(1);
    expect(h.service.ledgerRevision(ENV, CONVERSATION)).toBe(1);
  });

  test("a crash after the create commit is recovered by retrying the same key", async () => {
    let fail = true;
    const crashing = h.fork({
      faults: (stage) => {
        if (stage === "after-commit" && fail) {
          fail = false;
          throw new Error("simulated crash after commit");
        }
      },
    });
    const requestKey = key();
    const lost = await crashing.handleTool("create_artifact", TAB, {
      requestKey,
      draft: staticDraft(),
    });
    expect(lost.isError).toBe(true);
    const retried = await h.call("create_artifact", { requestKey, draft: staticDraft() });
    expect(retried.isError).toBe(false);
    expect(retried.replayed).toBe(true);
    expect(h.service.store.records(ENV).count("head")).toBe(1);
  });
});

describe("race table", () => {
  test("two updates with the same expected revision: one commits, the other conflicts", async () => {
    const artifactId = await create();
    const [a, b] = await Promise.all([
      h.call("update_artifact", {
        requestKey: key(),
        artifactId,
        expectedRevision: 1,
        draft: staticDraft("<p>a</p>"),
      }),
      h.call("update_artifact", {
        requestKey: key(),
        artifactId,
        expectedRevision: 1,
        draft: staticDraft("<p>b</p>"),
      }),
    ]);
    const outcomes = [a, b].map((result) => (result.isError ? result.error.code : "ok")).sort();
    expect(outcomes).toEqual(["ok", "revision_conflict"]);
    const conflict = [a, b].find((result) => result.isError)!;
    expect(conflict.error.currentRevision).toBe(2);
    const original = await h.call("get_artifact", {
      artifactId,
      revision: 1,
      sourceRange: { offsetBytes: 0, limitBytes: 100 },
    });
    expect(original.source.text).toBe("<p>v1</p>");
  });

  test("revision N previewing while N+1 is created: N's receipt cannot publish N+1", async () => {
    const artifactId = await create();
    h.runner.hold();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    const updated = await h.call("update_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      draft: staticDraft("<p>v2</p>"),
    });
    expect(updated.revision).toBe(2);
    h.runner.release();
    const operation = await settle(h, preview.operationId);
    expect(operation.operation.status).toBe("succeeded");
    const stale = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });
    expect(stale.error).toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    const wrong = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 2,
      receiptId: operation.operation.receiptId,
    });
    expect(wrong.error.code).toBe("preview_required");
  });

  test("update commits before publish: the publish fails its head check", async () => {
    const artifactId = await create();
    const receiptId = await verified(artifactId, 1);
    await h.call("update_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      draft: staticDraft("<p>v2</p>"),
    });
    const result = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      receiptId,
    });
    expect(result.error.code).toBe("revision_conflict");
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toHaveLength(0);
  });

  test("publish commits before update: N stays published and N+1 is a new draft", async () => {
    const artifactId = await create();
    const receiptId = await verified(artifactId, 1);
    const published = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      receiptId,
    });
    const updated = await h.call("update_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      draft: staticDraft("<p>v2</p>"),
    });
    expect(updated.revision).toBe(2);
    const ledger = h.service.publicationsForConversation(ENV, CONVERSATION);
    expect(ledger.map((entry) => [entry.publicationId, entry.revision])).toEqual([
      [published.publicationId, 1],
    ]);
    const metadata = await h.call("get_artifact", { artifactId });
    expect(metadata.artifact).toMatchObject({ currentRevision: 2, publishedRevision: 1 });
    // Publishing N+1 creates a separate publication; N's reference is not retargeted.
    const second = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: 2,
      receiptId: await verified(artifactId, 2),
    });
    const after = h.service.publicationsForConversation(ENV, CONVERSATION);
    expect(after.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(after[0]!.publicationId).toBe(published.publicationId);
    expect(second.conversationSequence).toBe(2);
  });

  test("cancel meets a queued job: the renderer never starts it", async () => {
    const artifactId = await create();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    const cancelled = await h.call("cancel_artifact_operation", {
      requestKey: key(),
      operationId: preview.operationId,
    });
    expect(cancelled.status).toBe("cancelled");
    await h.service.drain();
    expect(h.runner.calls).toHaveLength(0);
    expect((await settle(h, preview.operationId)).operation.status).toBe("cancelled");
  });

  test("cancel meets a running job: the flag persists, running stays running, success is fenced", async () => {
    const artifactId = await create();
    h.runner.hold();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    const requested = await h.call("cancel_artifact_operation", {
      requestKey: key(),
      operationId: preview.operationId,
    });
    expect(requested.status === "running" || requested.status === "cancelled").toBe(true);
    if (requested.status === "running")
      expect(typeof requested.cancellationRequestedAt).toBe("string");
    h.runner.release();
    const operation = await settle(h, preview.operationId);
    expect(operation.operation.status).toBe("cancelled");
    expect(operation.operation.receiptId).toBeUndefined();
  });

  test("cancel after completion reports the completed status", async () => {
    const artifactId = await create();
    await verified(artifactId, 1);
    const operationId = h.service.store.records(ENV).list("operation")[0]!.operationId;
    const result = await h.call("cancel_artifact_operation", { requestKey: key(), operationId });
    expect(result).toMatchObject({ status: "succeeded", alreadyCompleted: true });
  });

  test("a running job in another process honours a committed cancellation at commit", async () => {
    const artifactId = await create();
    h.runner.hold();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    const other = h.fork();
    const response = await other.handleTool("cancel_artifact_operation", TAB, {
      requestKey: key(),
      operationId: preview.operationId,
    });
    expect(response.value.status).toBe("running");
    h.runner.release();
    expect((await settle(h, preview.operationId)).operation.status).toBe("cancelled");
  });

  test("restart during rendering recovers as interrupted, never infers success, never publishes", async () => {
    const artifactId = await create();
    h.runner.hold();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    // A new process starts after the old one's lease lapsed.
    h.clock.now += 2 * 60_000;
    const restarted = h.fork();
    const report = await restarted.runCleanup();
    expect(report.interrupted).toBe(1);
    // The old process's late completion is fenced out.
    h.runner.release();
    await h.service.drain();
    const operation = await h.call("get_artifact_operation", { operationId: preview.operationId });
    expect(operation.operation.status).toBe("interrupted");
    expect(operation.operation.receiptId).toBeUndefined();
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toHaveLength(0);
    expect(h.service.metrics.total("late_completions_discarded")).toBeGreaterThan(0);
    // An explicit new preview works.
    expect(await verified(artifactId, 1)).toMatch(/^rcpt_/);
  });

  test("a live lease in another process is not interrupted", async () => {
    const artifactId = await create();
    h.runner.hold();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    expect((await h.fork().runCleanup()).interrupted).toBe(0);
    h.runner.release();
    expect((await settle(h, preview.operationId)).operation.status).toBe("succeeded");
  });

  test("the caller's turn ending (grant revoked) or a viewer closing does not cancel admitted work", async () => {
    const artifactId = await create();
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: TAB.projectId,
      conversationKey: CONVERSATION,
      turnId: "turn-1",
    });
    const shared = { environmentId: ENV, projectId: TAB.projectId };
    h.runner.hold();
    const preview = await h.service.handleTool("preview_artifact", shared, {
      requestKey: key(),
      artifactId,
      revision: 1,
      scopeCapability: grant.grant,
    });
    expect(preview.isError).toBe(false);
    await h.runner.started.promise;
    h.service.revokeArtifactGrantsForTurn(ENV, "turn-1");
    h.service.closeLiveSession("gen-unknown");
    h.runner.release();
    expect((await settle(h, preview.value.operationId as string)).operation.status).toBe(
      "succeeded",
    );
    // New mutations need current authorization.
    const denied = await h.service.handleTool("update_artifact", shared, {
      requestKey: key(),
      artifactId,
      expectedRevision: 1,
      draft: staticDraft(),
      scopeCapability: grant.grant,
    });
    expect((denied.value.error as { code: string }).code).toBe("policy_denied");
  });

  test("at most two nonterminal operations per conversation", async () => {
    const artifactId = await create();
    h.runner.hold();
    const results = [];
    for (
      let index = 0;
      index < PREVIEW_ADMISSION_POLICY.nonterminalPerConversation + 1;
      index += 1
    ) {
      results.push(
        await h.call("preview_artifact", { requestKey: key(), artifactId, revision: 1 }),
      );
    }
    expect(results.slice(0, 2).every((result) => result.ok)).toBe(true);
    expect(results[2]!.error).toMatchObject({
      code: "capacity_exceeded",
      resource: "conversation-operations",
      retryClass: "transient",
    });
    h.runner.release();
    await h.service.drain();
  });

  test("environment deletion during rendering discards the late completion", async () => {
    const artifactId = await create();
    h.runner.hold();
    await h.call("preview_artifact", { requestKey: key(), artifactId, revision: 1 });
    await h.runner.started.promise;
    await h.service.deleteEnvironment(ENV);
    h.runner.release();
    await h.service.drain();
    expect(h.service.store.isDeleted(ENV)).toBe(true);
    expect(h.service.store.database().listStores("transcript-artifacts/")).toEqual([]);
    const read = await h.call("get_artifact", { artifactId });
    expect(read.error.code).toBe("not_found");
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toEqual([]);
  });
});

describe("repair budget", () => {
  /** Previews `revision` of `artifactId` and waits for its terminal status. */
  async function previewStatus(artifactId: string, revision: number): Promise<string> {
    const preview = await h.call("preview_artifact", { requestKey: key(), artifactId, revision });
    return (await settle(h, preview.operationId)).operation.status;
  }

  function failBrokenHtml(): void {
    h.runner.respond = (job) =>
      job.kind === "html-static" && job.html.includes("BROKEN")
        ? {
            kind: job.kind,
            ok: false,
            error: {
              code: "validation_failed",
              message: "broken markup",
              retryClass: "after-edit",
            },
            diagnostics: [],
            omittedDiagnostics: 0,
            captures: [],
            blockedRequests: {},
            browserBuild: h.runner.browserBuild,
          }
        : null;
  }

  async function update(artifactId: string, expectedRevision: number, html: string) {
    return h.call("update_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision,
      draft: staticDraft(html),
    });
  }

  test("initial attempt plus two repairs after failed previews per turn; a new turn or a success resets it", async () => {
    failBrokenHtml();
    h.service.noteDispatchedTurn(ENV, CONVERSATION, "turn-a");
    const artifactId = await create("<p>BROKEN 1</p>");
    let revision = 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await previewStatus(artifactId, revision)).toBe("failed");
      const repaired = await update(artifactId, revision, `<p>BROKEN ${attempt + 2}</p>`);
      expect(repaired.isError).toBe(false);
      revision = repaired.revision;
    }
    expect(await previewStatus(artifactId, revision)).toBe("failed");
    const exhausted = await update(artifactId, revision, "<p>fixed</p>");
    expect(exhausted.error.code).toBe("repair_budget_exhausted");
    // Draft source and diagnostics remain inspectable.
    expect((await h.call("get_artifact", { artifactId })).artifact.currentRevision).toBe(revision);
    h.service.noteDispatchedTurn(ENV, CONVERSATION, "turn-b");
    const nextTurn = await update(artifactId, revision, "<p>fixed</p>");
    expect(nextTurn.isError).toBe(false);
    revision = nextTurn.revision;
    await verified(artifactId, revision);
    expect(h.service.metrics.total("repair_budget_exhausted")).toBe(1);
    expect(h.service.metrics.total("repairs")).toBe(3);
  });

  test("updates before any preview or after a successful one are not repairs", async () => {
    failBrokenHtml();
    h.service.noteDispatchedTurn(ENV, CONVERSATION, "turn-a");
    const artifactId = await create("<p>v1</p>");
    let revision = 1;
    // Deliberate edits with no preview in between: never repairs.
    for (let edit = 0; edit < 4; edit += 1) {
      const updated = await update(artifactId, revision, `<p>edit ${edit}</p>`);
      expect(updated.isError).toBe(false);
      revision = updated.revision;
    }
    // Edits after a successful preview: not repairs either.
    for (let edit = 0; edit < 3; edit += 1) {
      await verified(artifactId, revision);
      const updated = await update(artifactId, revision, `<p>after success ${edit}</p>`);
      expect(updated.isError).toBe(false);
      revision = updated.revision;
    }
    expect(h.service.metrics.total("repairs")).toBe(0);
    // A failed preview of the previous revision makes the next update a repair.
    const broken = await update(artifactId, revision, "<p>BROKEN</p>");
    revision = broken.revision;
    expect(await previewStatus(artifactId, revision)).toBe("failed");
    expect((await update(artifactId, revision, "<p>repair</p>")).isError).toBe(false);
    expect(h.service.metrics.total("repairs")).toBe(1);
  });

  test("transient renderer failures retry at most twice", async () => {
    let calls = 0;
    h.runner.respond = (job) => {
      calls += 1;
      return {
        kind: job.kind,
        ok: false,
        error: { code: "storage_unavailable", message: "worker crashed", retryClass: "transient" },
        diagnostics: [],
        omittedDiagnostics: 0,
        captures: [],
        blockedRequests: {},
        browserBuild: "x",
      };
    };
    const artifactId = await create();
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId,
      revision: 1,
    });
    const operation = await settle(h, preview.operationId);
    expect(operation.operation.status).toBe("failed");
    expect(calls).toBe(3);
  });
});

test("shutdown interrupts active previews and reopening preserves that outcome", async () => {
  const artifactId = await create();
  h.runner.hold();
  const preview = await h.call("preview_artifact", { requestKey: key(), artifactId, revision: 1 });
  await h.runner.started.promise;
  await h.service.close();
  const reopened = h.fork();
  try {
    const records = reopened.store.records(ENV);
    expect(records.get("operation", preview.operationId)?.status).toBe("interrupted");
    expect(records.count("repair")).toBe(0);
  } finally {
    await reopened.close();
  }
});
