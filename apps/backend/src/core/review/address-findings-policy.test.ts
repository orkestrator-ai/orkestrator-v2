import { expect, test } from "bun:test";
import {
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { CommandContext } from "../commands/context.js";
import { createCommandRegistry } from "../commands/registry.js";
import type { AddressFindingsPackageVerifier } from "./address-findings-validation.js";
import {
  Provider,
  REVIEW_HEAD,
  advanceUntil,
  consolidatedReport,
  fixtureAddressFindingsVerifier,
  seedLegacyFixingWorkflow,
  withService,
} from "./service-test-support.js";

test.each(["custom", "restart", "reconsolidate", "automatic"] as const)(
  "Multi Review records and delivers the current opt-in on a %s launch",
  async (kind) => {
    const provider = new Provider();
    provider.reviewerReport = consolidatedReport;
    const delivered = new Map<string, string>();
    const environmentId = "env-address-policy";
    await withService(
      environmentId,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const automatic = kind === "automatic";
        if (automatic) await storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: true });
        const started = await start();
        const id = started.id;
        const advance = (done: Parameters<typeof advanceUntil>[3]) =>
          advanceUntil(service, snapshot, id, done);
        if (!automatic) {
          await advance((current) => current.phase === "ready");
          if (kind !== "custom") {
            const original = await service.address(id);
            await advance((current) => current.addressPromptPending !== true);
            expect(delivered.get(original.addressRequestId!)).toBe("excuse");
          }
          await storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: true });
          if (kind === "custom") {
            await service.customAddressFindings({
              workflowId: id,
              instruction: "Repair the recorded test failure.",
              addressFindingsModel: { agent: "claude", model: "opus" },
            });
          } else {
            await service.restartStep(id, kind === "restart" ? "address-findings" : "consolidate");
          }
        }
        await advance(
          (current) => current.phase === "interactive" && current.addressPromptPending !== true,
        );
        const record = await storage.getMultiReviewWorkflow(id);
        expect(record?.addressFindingsRepair?.policy).toBe("repair");
        expect(delivered.get(record!.addressFindingsRepair!.requestId)).toBe("repair");

        // Get and List are the two renderer hydration paths. Their snapshot
        // still passes the same strict shape as it did before the new setting.
        const registry = createCommandRegistry();
        const context = { storage } as CommandContext;
        const point = await registry.get("get_multi_review_workflow")!({ workflowId: id }, context);
        const list = await registry.get("list_multi_review_workflows")!({ environmentId }, context);
        expect(list).toContainEqual(point);
        expect(point).not.toHaveProperty("addressFindingsRepair");
        const wireSnapshot = (point as { snapshot: unknown }).snapshot;
        expect(isMultiReviewWorkflow(wireSnapshot)).toBe(true);
        expect(wireSnapshot).not.toHaveProperty("addressFindingsPreExistingFailures");
      },
      {
        packageFlow: kind === "automatic",
        autoAddressFindings: kind === "automatic",
        serviceOptions: {
          dispatchAddressFindingsPrompt: async (workflow, _presentation, policy) => {
            delivered.set(workflow.addressRequestId!, policy);
          },
        },
      },
    );
  },
);

test("an unattended Address dispatch uses its prepared request's policy after the setting changes", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  const environmentId = "env-unattended-address-policy";
  const verify = fixtureAddressFindingsVerifier();
  let onVerify: () => Promise<void> = async () => {};
  const verifyAndChangeSetting: AddressFindingsPackageVerifier = async (...args) => {
    await onVerify();
    return verify(...args);
  };
  await withService(
    environmentId,
    provider,
    async ({ service, storage, snapshot }) => {
      const id = await seedLegacyFixingWorkflow(storage, environmentId);
      const sha256 = "b".repeat(64);
      const stored = (await storage.getMultiReviewWorkflow(id))!;
      const workflow = stored.snapshot as MultiReviewWorkflow;
      workflow.reviewPackage = {
        kind: "file",
        id: "review-package-address",
        round: 1,
        preparedAt: new Date(0).toISOString(),
        targetBranch: "main",
        baseRef: "a".repeat(40),
        headRef: REVIEW_HEAD,
        filePath: reviewPackageArtifactPath("review-package-address", sha256),
        sha256,
        bytes: 1024,
        changedFileCount: 1,
        limitations: [],
      };
      // New Reviews queue interactive Address Findings after consolidation.
      // Seed the historical unattended phase with its durable prepared request.
      await storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: true });
      await storage.saveMultiReviewWorkflow(
        id,
        environmentId,
        stored.version,
        workflow,
        stored.revision,
        undefined,
        { requestId: workflow.activeRequest!.requestId, policy: "repair" },
      );
      onVerify = async () => {
        const prepared = await snapshot(id);
        if (prepared?.activeRequest?.state !== "prepared") {
          throw new Error("Expected an unattended prepared request");
        }
        expect((await storage.getMultiReviewWorkflow(id))?.addressFindingsRepair).toEqual({
          requestId: prepared.activeRequest.requestId,
          policy: "repair",
        });
        await storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: false });
      };

      const sent = await advanceUntil(
        service,
        snapshot,
        id,
        (current) => current.activeRequest?.state === "sent" || current.phase === "failed",
      );
      expect(sent.phase).toBe("addressing-findings");
      expect(provider.sends.get(sent.activeRequest!.requestId)?.prompt).toContain(
        "**Pre-existing failures**",
      );
      expect((await storage.loadConfig()).global.addressFindingsRepairsPreExisting).toBe(false);
    },
    { serviceOptions: { verifyAddressFindingsPackage: verifyAndChangeSetting } },
  );
});
