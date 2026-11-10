/**
 * A browser tab of an environment on another machine: its captures are
 * committed, and its lost responses resumed, on that machine's backend only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WEB_ANNOTATION_COMMANDS } from "@orkestrator/protocol/web-annotations";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { forgetSaveIntent, saveIntent } from "@/lib/web-annotations/capture-intents";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
  seedPending,
} from "@/test/web-annotation-fakes";
import { useAnnotationCapture } from "./useAnnotationCapture";

// Both nodes know an environment with this id, so only the scope decides
// which backend a call reaches.
const ENV = "env-1";

let local: FakeWebAnnotationBackend;
let remote: FakeWebAnnotationBackend;
let client: FakeNodeClient;
let windowScope: WindowScope;
let scope: NodeScope;
let capture: ReturnType<typeof createFakeCaptureApi>;
let bus: ReturnType<typeof installFakeOrkestrator>;

function localAnnotationCalls() {
  return local.calls.filter((call) => call.command.startsWith("web_annotation"));
}

function renderRemoteCapture() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
    </WindowScopeProvider>
  );
  return renderHook(
    () =>
      useAnnotationCapture({
        tabId: "browser-1",
        environmentId: ENV,
        isActive: true,
        enabled: true,
      }),
    { wrapper },
  );
}

describe("useAnnotationCapture on another machine's environment", () => {
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
    local = new FakeWebAnnotationBackend(ENV).install();
    remote = new FakeWebAnnotationBackend(ENV);
    client = new FakeNodeClient({ nodeId: "bk_remote-node" as BackendId });
    for (const command of Object.values(WEB_ANNOTATION_COMMANDS)) {
      client.respond(command, (args: Readonly<Record<string, unknown>>) =>
        remote.handle(command, { ...args }),
      );
    }
    windowScope = new WindowScope();
    scope = windowScope.open({ role: "leaf", client });
  });
  afterEach(() => {
    cleanup();
    forgetSaveIntent("cap-remote");
    resetWebAnnotationSyncForTests();
    windowScope.dispose();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("an explicit save commits on the owning node", async () => {
    seedPending(capture.spool, { captureId: "cap-remote", environmentId: ENV });
    const { result } = renderRemoteCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    await act(async () => {
      const outcome = await result.current.save("cap-remote", { body: "Pills, please" });
      expect(outcome.ok).toBe(true);
    });

    // Mount's resume and the save's own lost-response check both ask here.
    expect(remote.callsOf("web_annotation_operation_receipt").length).toBeGreaterThan(0);
    expect(remote.callsOf("web_annotation_asset_stage")).toHaveLength(1);
    expect(remote.callsOf("web_annotation_create")).toHaveLength(1);
    expect(remote.callsOf("web_annotation_create")[0]!.args).toMatchObject({
      environmentId: ENV,
      body: "Pills, please",
    });
    expect(result.current.saveState("cap-remote").status).toBe("saved");
    expect(localAnnotationCalls()).toEqual([]);
  });

  test("a lost response is resumed from the owning node's receipt, without a duplicate", async () => {
    seedPending(capture.spool, { captureId: "cap-remote", environmentId: ENV });
    const { result } = renderRemoteCapture();
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    // The remote backend commits, then the response is lost on the way back.
    remote.fail("web_annotation_create", new Error("Gateway disconnected"), { afterCommit: true });

    await act(async () => {
      const outcome = await result.current.save("cap-remote", { body: "Committed once" });
      expect(outcome.ok).toBe(false);
    });
    expect(result.current.saveState("cap-remote")).toMatchObject({
      status: "error",
      retrying: true,
    });
    // The renderer also lost the save intent (a reload), so only the receipt
    // lookup on resume can tell the capture was committed.
    forgetSaveIntent("cap-remote");
    expect(saveIntent("cap-remote")).toBeNull();
    const receiptReads = remote.callsOf("web_annotation_operation_receipt").length;

    await act(async () => {
      bus.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    });

    await waitFor(() =>
      expect(capture.mocks.acknowledgePendingCapture).toHaveBeenCalledWith(
        expect.objectContaining({ captureId: "cap-remote" }),
      ),
    );
    await waitFor(() => expect(result.current.saveState("cap-remote").status).toBe("saved"));
    expect(remote.callsOf("web_annotation_operation_receipt").length).toBeGreaterThan(receiptReads);
    expect(remote.callsOf("web_annotation_create")).toHaveLength(1);
    expect(result.current.lastCommitted).toMatchObject({ automatic: true });
    expect(localAnnotationCalls()).toEqual([]);
  });
});
