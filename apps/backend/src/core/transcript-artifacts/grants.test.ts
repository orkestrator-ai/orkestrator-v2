import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ARTIFACT_TOOL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  CONVERSATION,
  ENV,
  PROJECT,
  SAMPLE_CHART,
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
  await h.close();
});

const SHARED = { environmentId: ENV, projectId: PROJECT };
const chartDraft = { title: "Chart", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } };

async function sharedCall(
  name: Parameters<Harness["call"]>[0],
  args: Record<string, unknown>,
  scope = SHARED,
) {
  return h.call(name, args, scope);
}

describe("ownership and scope", () => {
  test("records outside the caller's conversation, environment or backend are not_found", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft });
    const otherTab = { ...TAB, tabId: "tab-2" };
    const otherEnv = { ...TAB, environmentId: "env-2" };
    for (const scope of [otherTab, otherEnv]) {
      const read = await h.call("get_artifact", { artifactId: created.artifactId }, scope);
      expect(read.error.code).toBe("not_found");
      const update = await h.call(
        "update_artifact",
        {
          requestKey: key(),
          artifactId: created.artifactId,
          expectedRevision: 1,
          draft: chartDraft,
        },
        scope,
      );
      expect(update.error.code).toBe("not_found");
    }
    const missing = await h.call("get_artifact", { artifactId: "art_doesnotexist000" });
    expect(
      (await h.call("get_artifact", { artifactId: created.artifactId }, otherTab)).error,
    ).toEqual(missing.error);

    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      revision: 1,
    });
    const operation = await settle(h, preview.operationId);
    expect(
      (await h.call("get_artifact_operation", { operationId: preview.operationId }, otherTab)).error
        .code,
    ).toBe("not_found");
    const published = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });

    // Renderer reads: wrong conversation or a foreign backend id.
    await expect(
      h.service.getPublication(
        { environmentId: ENV, logicalSessionKey: "env-env-1:tab-2" },
        published.publicationId,
      ),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
    await expect(
      h.service.getPublication(
        { environmentId: "env-2", logicalSessionKey: CONVERSATION },
        published.publicationId,
      ),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
    expect(
      h.service.listPublications({ environmentId: ENV, logicalSessionKey: "env-env-1:tab-2" })
        .publications,
    ).toEqual([]);
    h.service.store.transact(ENV, (records) => {
      const row = records.get("publication", published.publicationId)!;
      records.put(
        "publication",
        row.publicationId,
        { ...row, owner: { ...row.owner, backendId: "another-backend" } },
        row.owner.conversationKey,
      );
    });
    await expect(
      h.service.getPublication(
        { environmentId: ENV, logicalSessionKey: CONVERSATION },
        published.publicationId,
      ),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toEqual([]);
  });

  test("reopening the conversation in another tab with the same logical key recovers artifacts", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft });
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: PROJECT,
      conversationKey: CONVERSATION,
      turnId: "t-2",
    });
    const read = await sharedCall("get_artifact", {
      artifactId: created.artifactId,
      scopeCapability: grant.grant,
    });
    expect(read.artifact.artifactId).toBe(created.artifactId);
  });

  test("workflow-result credentials cannot use artifact tools", async () => {
    for (const scope of [
      { ...SHARED, workflowResultKey: crypto.randomUUID() },
      { ...SHARED, workflowResultBroker: true },
    ]) {
      const result = await h.call(
        "create_artifact",
        { requestKey: key(), draft: chartDraft },
        scope,
      );
      expect(result.error.code).toBe("policy_denied");
    }
  });
});

describe("artifact grants", () => {
  test("environment-wide credentials need a grant; the grant binds the conversation and turn", async () => {
    const denied = await sharedCall("create_artifact", { requestKey: key(), draft: chartDraft });
    expect(denied.error.code).toBe("policy_denied");
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: PROJECT,
      conversationKey: "env-env-1:opencode-tab",
      turnId: "turn-9",
      providerSessionId: "ses_1",
    });
    expect(Date.parse(grant.expiresAt) - h.clock.now).toBeLessThanOrEqual(
      ARTIFACT_TOOL_POLICY.scopeCapabilityTtlMs,
    );
    const created = await sharedCall("create_artifact", {
      requestKey: key(),
      draft: chartDraft,
      scopeCapability: grant.grant,
    });
    expect(created.isError).toBe(false);
    const head = h.service.store.records(ENV).get("head", created.artifactId)!;
    expect(head.owner.conversationKey).toBe("env-env-1:opencode-tab");
    expect(head.createdTurnId).toBe("turn-9");
    // Only digests are stored.
    const stored = JSON.stringify(
      h.service.store.database().rows("transcript-artifact-grants").list(),
    );
    expect(stored).not.toContain(grant.grant);
    // A tab credential of a different conversation cannot borrow it.
    const borrowed = await h.call("get_artifact", {
      artifactId: created.artifactId,
      scopeCapability: grant.grant,
    });
    expect(borrowed.error.code).toBe("policy_denied");
  });

  test("forged, tampered, expired, revoked and out-of-scope grants are refused", async () => {
    const mint = (turnId = "turn-1", verbs?: Array<"read">) =>
      h.service.mintArtifactGrant({
        environmentId: ENV,
        projectId: PROJECT,
        conversationKey: CONVERSATION,
        turnId,
        ...(verbs ? { verbs } : {}),
      });
    const valid = mint();
    const parts = valid.grant.split(".");
    const forged = [
      `oag1.${"A".repeat(22)}.${"B".repeat(43)}`,
      `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -1)}${parts[2]!.endsWith("A") ? "B" : "A"}`,
      "garbage",
    ];
    for (const token of forged) {
      expect(
        (await sharedCall("get_artifact", { artifactId: "art_x00000000", scopeCapability: token }))
          .error.code,
      ).toBe("policy_denied");
    }
    // Other environment or project.
    expect(
      (
        await sharedCall(
          "get_artifact",
          { artifactId: "art_x00000000", scopeCapability: valid.grant },
          { environmentId: "env-2", projectId: PROJECT },
        )
      ).error.code,
    ).toBe("policy_denied");
    // Verb restriction.
    const readOnly = mint("turn-r", ["read"]);
    expect(
      (
        await sharedCall("create_artifact", {
          requestKey: key(),
          draft: chartDraft,
          scopeCapability: readOnly.grant,
        })
      ).error.code,
    ).toBe("policy_denied");
    // Revocation per turn.
    const turnGrant = mint("turn-2");
    expect(
      (
        await sharedCall("create_artifact", {
          requestKey: key(),
          draft: chartDraft,
          scopeCapability: turnGrant.grant,
        })
      ).isError,
    ).toBe(false);
    expect(h.service.revokeArtifactGrantsForTurn(ENV, "turn-2")).toBe(1);
    expect(
      (
        await sharedCall("create_artifact", {
          requestKey: key(),
          draft: chartDraft,
          scopeCapability: turnGrant.grant,
        })
      ).error.code,
    ).toBe("policy_denied");
    // A fresh grant for the same owner can still read earlier work.
    const fresh = mint("turn-3");
    expect(
      (
        await sharedCall("get_artifact", {
          artifactId: "art_x00000000",
          scopeCapability: fresh.grant,
        })
      ).error.code,
    ).toBe("not_found");
    // Expiry (24 h hard limit).
    h.clock.now += ARTIFACT_TOOL_POLICY.scopeCapabilityTtlMs + 1;
    expect(
      (
        await sharedCall("get_artifact", {
          artifactId: "art_x00000000",
          scopeCapability: fresh.grant,
        })
      ).error.code,
    ).toBe("policy_denied");
    // Environment revocation also invalidates grants minted earlier.
    h.clock.now -= ARTIFACT_TOOL_POLICY.scopeCapabilityTtlMs + 1;
    const beforeRevoke = mint("turn-4");
    h.service.grants.revokeEnvironment(ENV);
    expect(
      (
        await sharedCall("get_artifact", {
          artifactId: "art_x00000000",
          scopeCapability: beforeRevoke.grant,
        })
      ).error.code,
    ).toBe("policy_denied");
    expect(
      (
        await sharedCall("get_artifact", {
          artifactId: "art_x00000000",
          scopeCapability: mint("turn-5").grant,
        })
      ).error.code,
    ).toBe("not_found");
  });

  test("a grant from another data directory (another backend) is refused", async () => {
    const other = await createHarness();
    try {
      const foreign = other.service.mintArtifactGrant({
        environmentId: ENV,
        projectId: PROJECT,
        conversationKey: CONVERSATION,
        turnId: "t",
      });
      expect(
        (
          await sharedCall("get_artifact", {
            artifactId: "art_x00000000",
            scopeCapability: foreign.grant,
          })
        ).error.code,
      ).toBe("policy_denied");
    } finally {
      await other.close();
    }
  });
});
