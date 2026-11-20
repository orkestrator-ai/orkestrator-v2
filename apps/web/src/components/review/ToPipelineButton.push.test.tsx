/**
 * The toolbar's "To pipeline" over the `workflow` push topic's
 * `auto-pipeline` key (docs/architecture/push-events.md): it reads the
 * environment's offer when a frame names it, and its backstop falls to the
 * recovery cadence while the subscription is healthy.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { PUSH_RECOVERY_POLL_MS, PUSH_STREAM_STATE_EVENT } from "@orkestrator/protocol/push-events";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { readCoordinatorFor, readKeyId } from "@/lib/read-coordinator";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  acceptPushSets,
  connectPush,
  emitPushChange,
  subscribedPushKeys,
} from "@/test/push-fixture";
import { ToPipelineButton } from "./ToPipelineButton";

const KEY = "auto-pipeline/env";

afterEach(cleanupNodeScopes);

function setup() {
  const offer = {
    available: true,
    sources: [{ tabId: "original", label: "Original work" } as Record<string, unknown>],
  };
  const node = new FakeNodeClient({
    invoke: {
      auto_pipeline_sources: () => offer,
      push_set_subscriptions: acceptPushSets,
    },
  });
  const view = renderInNodeScope(<ToPipelineButton environmentId="env" createTab={() => true} />, {
    client: node,
  });
  act(() => {
    view.scope.store(paneLayoutStore).setState({
      environments: new Map([
        [
          "env",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "original", type: "agent-native" }],
              activeTabId: "original",
            },
            activePaneId: "default",
            containerId: null,
            backendRevision: 0,
          },
        ],
      ]) as never,
    });
  });
  const reads = () => node.calls("auto_pipeline_sources").length;
  const interval = () =>
    readCoordinatorFor(view.scope)
      .getDiagnostics()
      .entries.find(
        (entry) =>
          entry.id ===
          readKeyId({ resource: "auto-pipeline-sources", target: "env", view: "original" }),
      )?.cadenceMs;
  return { node, view, offer, reads, interval };
}

test("reads the offer on a frame and polls at the recovery cadence while healthy", async () => {
  const { node, view, offer, reads, interval } = setup();
  expect(await screen.findByRole("button", { name: "To pipeline" })).toBeTruthy();
  expect(interval()).toBe(2000);
  await connectPush(node, view.scope, "workflow", KEY);
  expect(subscribedPushKeys(node)).toEqual([`workflow ${KEY}`]);
  await waitFor(() => expect(interval()).toBe(PUSH_RECOVERY_POLL_MS));

  // The tab's turn started: the backend announces it and the button greys out.
  offer.sources = [
    { tabId: "original", label: "Original work", disabledReason: "Wait for this tab's turn" },
  ];
  const before = reads();
  await emitPushChange(node, 1, "workflow", KEY, ["progress"]);
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "To pipeline" }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );

  // The stream drops: back to the old cadence, with a read for what was missed.
  const dropped = reads();
  await act(async () => {
    node.emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
  });
  await waitFor(() => expect(interval()).toBe(2000));
  await waitFor(() => expect(reads()).toBeGreaterThan(dropped));
});
