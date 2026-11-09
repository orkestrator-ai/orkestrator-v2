import { afterEach, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import type { MultiReviewLaunchDefaultRows } from "@/lib/backend";
import { useMultiReviewLaunchDefaults } from "./useMultiReviewLaunchDefaults";

afterEach(cleanupNodeScopes);

function deferred() {
  let resolve!: (value: MultiReviewLaunchDefaultRows) => void;
  const promise = new Promise<MultiReviewLaunchDefaultRows>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const rows = (model: string): MultiReviewLaunchDefaultRows => ({
  reviewers: [{ agent: "codex", model }],
  reviewModel: { agent: "codex", model },
  fixModel: { agent: "codex", model },
  autoFix: false,
  autoPr: false,
});

for (const transition of ["close", "reopen", "environment"] as const) {
  test(`ignores obsolete defaults after ${transition} while a read is pending`, async () => {
    const old = deferred();
    const fresh = deferred();
    const client = new FakeNodeClient({
      invoke: {
        get_multi_review_launch_defaults: () => old.promise,
      },
    });
    const { scope, windowScope } = renderInNodeScope(<div />, { client });
    const { result, rerender, unmount } = renderHook(
      ({ open, environmentId }) => useMultiReviewLaunchDefaults(open, environmentId),
      {
        initialProps: { open: true, environmentId: "first" },
        wrapper: ({ children }) => (
          <WindowScopeProvider windowScope={windowScope}>
            <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
          </WindowScopeProvider>
        ),
      },
    );
    expect(result.current).toEqual({ status: "loading" });
    client.respond("get_multi_review_launch_defaults", () => fresh.promise);
    if (transition !== "environment") rerender({ open: false, environmentId: "first" });
    if (transition === "close") {
      await act(async () => old.resolve(rows("obsolete")));
      expect(result.current).toBeUndefined();
    } else {
      rerender({ open: true, environmentId: transition === "environment" ? "second" : "first" });
      expect(result.current).toEqual({ status: "loading" });
      await act(async () => fresh.resolve(rows("current")));
      expect(result.current).toEqual({ status: "ready", selection: rows("current") });
      await act(async () => old.resolve(rows("obsolete")));
      expect(result.current).toEqual({ status: "ready", selection: rows("current") });
      expect(
        client.calls("get_multi_review_launch_defaults").map((call) => call.args.environmentId),
      ).toEqual(["first", transition === "environment" ? "second" : "first"]);
    }
    unmount();
  });
}
