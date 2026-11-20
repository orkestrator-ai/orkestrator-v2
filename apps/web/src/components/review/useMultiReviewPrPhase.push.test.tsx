/**
 * The Multi Review PR step over the `native-session` push topic
 * (docs/architecture/push-events.md): it subscribes the PR tab's session and
 * reads its phase when a frame names it.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import type { getNativeAgentSessionStateUpdate } from "@/lib/backend";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  acceptPushSets,
  connectPush,
  emitPushChange,
  subscribedPushKeys,
} from "@/test/push-fixture";
import { pushDiagnostics } from "@/lib/push/push-subscriptions";
import { useMultiReviewPrPhase } from "./useMultiReviewPrPhase";

afterEach(cleanupNodeScopes);

const KEY = "env-1/codex/env-env-1:pr";

type Update = Awaited<ReturnType<typeof getNativeAgentSessionStateUpdate>>;

function Probe({
  load,
  active = true,
}: {
  load: typeof getNativeAgentSessionStateUpdate;
  active?: boolean;
}) {
  const phase = useMultiReviewPrPhase({
    environmentId: "env-1",
    tabId: "pr",
    agent: "codex",
    active,
    loadSessionState: load,
  });
  return <div data-testid="phase" data-phase={phase ?? ""} />;
}

function setup(active = true) {
  let phase = "running";
  const load = mock(
    async (): Promise<Update> =>
      ({
        status: "snapshot",
        value: { turn: { phase } },
      }) as unknown as Update,
  );
  const node = new FakeNodeClient({ invoke: { push_set_subscriptions: acceptPushSets } });
  const view = renderInNodeScope(<Probe load={load} active={active} />, { client: node });
  return {
    node,
    view,
    load,
    setPhase: (next: string) => {
      phase = next;
    },
  };
}

test("subscribes the PR tab's session and reads its phase on a frame", async () => {
  const { node, view, load, setPhase } = setup();
  await waitFor(() => expect(load).toHaveBeenCalled());
  await connectPush(node, view.scope, "native-session", KEY);
  expect(subscribedPushKeys(node)).toEqual([`native-session ${KEY}`]);
  setPhase("idle");
  const before = load.mock.calls.length;
  await emitPushChange(node, 1, "native-session", KEY, ["state"]);
  await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() => expect(view.getByTestId("phase").getAttribute("data-phase")).toBe("idle"));
});

test("an inactive step subscribes nothing", async () => {
  const { node, view, load } = setup(false);
  await act(async () => undefined);
  expect(load).not.toHaveBeenCalled();
  expect(node.calls("push_set_subscriptions")).toHaveLength(0);
  expect(pushDiagnostics(view.scope)).toBeNull();
});
