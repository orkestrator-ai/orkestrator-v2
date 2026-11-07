import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { MultiReviewLaunchSelection } from "@/components/review/MultiReviewLaunchDialog";
import { legacyLaunchMultiReview } from "@/lib/multi-review-launch-compat";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { workflowVocabularyFixtures } from "./workflow-vocabulary.test-support";

const MODEL = { agent: "claude", model: "opus" } as MultiReviewLaunchSelection["reviewModel"];
const SELECTION: MultiReviewLaunchSelection = {
  autoFix: false,
  autoPr: false,
  reviewers: [MODEL],
  reviewModel: MODEL,
  fixModel: MODEL,
};

describe("legacyLaunchMultiReview per node scope (plan item 3003)", () => {
  let windowScope: WindowScope;
  let command: NodeScope;
  let leaf: NodeScope;
  let client: FakeNodeClient;

  beforeEach(() => {
    windowScope = new WindowScope();
    command = windowScope.open({
      role: "command",
      client: new FakeNodeClient({ nodeId: "bk_legacy-review-a" as BackendId }),
    });
    client = new FakeNodeClient({ nodeId: "bk_legacy-review-b" as BackendId });
    leaf = windowScope.open({ role: "leaf", client });
  });

  afterEach(() => windowScope.dispose());

  test("starts the review on the scope's node and installs it in that scope", async () => {
    const { review } = workflowVocabularyFixtures();
    client.respond("list_multi_review_workflows", []).respond("start_multi_review", review);
    const opened: string[] = [];

    const result = await legacyLaunchMultiReview({
      scope: leaf,
      environmentId: review.environmentId,
      projectId: review.projectId,
      targetBranch: "main",
      reviewInstruction: undefined,
      selection: SELECTION,
      createTab: (workflowId) => {
        opened.push(workflowId);
        return true;
      },
    });

    expect(result).toEqual({ reused: false });
    expect(opened).toEqual([review.id]);
    expect(client.calls("list_multi_review_workflows")).toHaveLength(1);
    expect(client.calls("start_multi_review")[0]?.args).toMatchObject({
      environmentId: review.environmentId,
      projectId: review.projectId,
    });
    expect(leaf.store(multiReviewStore).getState().workflows.has(review.id)).toBe(true);
    expect(command.store(multiReviewStore).getState().workflows.size).toBe(0);
  });
});
