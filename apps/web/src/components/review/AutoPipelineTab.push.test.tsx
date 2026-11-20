/**
 * The Auto-pipeline tab over the `workflow` push topic's `auto-pipeline` key
 * (docs/architecture/push-events.md): while shown and healthy it reads when a
 * frame names its draft; it no longer reads on a bare interval while hidden.
 */
import { afterEach, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { AutoPipelineState } from "@orkestrator/protocol/build-pipeline";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  acceptPushSets,
  connectPush,
  emitPushChange,
  subscribedPushKeys,
} from "@/test/push-fixture";
import { pushDiagnostics } from "@/lib/push/push-subscriptions";
import { disposeAutoPipelineHandoffs } from "./auto-pipeline-handoff";
import { AutoPipelineTab, resetAutoPipelineUnsavedEditsForTests } from "./AutoPipelineTab";

const KEY = "auto-pipeline/env:original";

afterEach(() => {
  disposeAutoPipelineHandoffs();
  cleanupNodeScopes();
  resetAutoPipelineUnsavedEditsForTests();
});

function setup(isActive = true) {
  const holder: { state: AutoPipelineState } = { state: { phase: "idle" } };
  const node = new FakeNodeClient({
    invoke: {
      get_auto_pipeline_state: () => holder.state,
      draft_auto_pipeline: () => new Promise(() => undefined),
      push_set_subscriptions: acceptPushSets,
    },
  });
  const view = renderInNodeScope(
    <AutoPipelineTab
      tabId="auto"
      environmentId="env"
      data={{ sourceTabId: "original", sourceLabel: "Original work" }}
      isActive={isActive}
    />,
    { client: node },
  );
  const reads = () => node.calls("get_auto_pipeline_state").length;
  return { node, view, holder, reads };
}

test("subscribes its own draft and reads when a frame names it", async () => {
  const { node, view, holder, reads } = setup();
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
  await connectPush(node, view.scope, "workflow", KEY);
  expect(subscribedPushKeys(node)).toEqual([`workflow ${KEY}`]);
  const before = reads();
  holder.state = { phase: "drafting" };
  await emitPushChange(node, 1, "workflow", KEY, ["status", "progress"]);
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  expect(await screen.findByText(/Waiting for the agent in the source tab/)).toBeTruthy();
  // Another tab's draft is not this tab's: the client ignores the change.
  const ignored = pushDiagnostics(view.scope)?.changesIgnored ?? 0;
  await emitPushChange(node, 2, "workflow", "auto-pipeline/env:other", ["progress"]);
  expect(pushDiagnostics(view.scope)?.changesIgnored).toBe(ignored + 1);
});

test("a hidden tab subscribes nothing and reads nothing", async () => {
  const { node, view, reads } = setup(false);
  await act(async () => undefined);
  expect(reads()).toBe(0);
  expect(node.calls("push_set_subscriptions")).toHaveLength(0);
  // Nothing attached a push client for this node.
  expect(pushDiagnostics(view.scope)).toBeNull();
});
