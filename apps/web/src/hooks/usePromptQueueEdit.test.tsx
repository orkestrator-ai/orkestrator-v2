import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import { usePromptQueueEdit, type PromptQueueEditApi } from "./usePromptQueueEdit";

const image = { type: "image" as const, path: "/workspace/shot.png", filename: "shot.png" };
const stored = {
  id: "second",
  text: buildInitialPromptWithAttachmentReferences("Check this", [
    { name: "shot.png", path: image.path },
  ]),
  attachments: [image],
  model: "gpt-5",
};

function lease(leaseId: string) {
  return {
    messageId: "second",
    leaseId,
    acquiredAt: "2026-11-19T12:00:00.000Z",
    expiresAt: "2026-11-19T12:01:00.000Z",
    baseFingerprint: "0".repeat(64),
  };
}

function fakeApi() {
  let next = 0;
  const begin = mock(async (_messageId: string, _options?: { takeOver?: boolean }) => ({
    status: "editing" as const,
    lease: lease(`lease-${++next}`),
    message: stored,
    queue: null,
  }));
  const renew = mock(async () => ({ status: "renewed" as const, expiresAt: "" }));
  const finish = mock(
    async (
      _messageId: string,
      _leaseId: string,
      _finish: Parameters<PromptQueueEditApi["finish"]>[2],
    ): ReturnType<PromptQueueEditApi["finish"]> => ({ status: "committed", queue: null }),
  );
  return { begin, renew, finish } satisfies PromptQueueEditApi;
}

afterEach(() => cleanup());

describe("usePromptQueueEdit", () => {
  test("begins from the text a person wrote and commits text and files together", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.begin("second"));
    expect(result.current.session).toMatchObject({
      messageId: "second",
      leaseId: "lease-1",
      text: "Check this",
      attachments: [image],
    });

    act(() => result.current.setText("Check this again"));
    await act(() => result.current.save());
    expect(api.finish).toHaveBeenCalledWith("second", "lease-1", {
      outcome: "commit",
      text: buildInitialPromptWithAttachmentReferences("Check this again", [
        { name: "shot.png", path: image.path },
      ]),
      attachments: [image],
    });
    expect(result.current.session).toBeNull();
  });

  test("saving an unchanged edit releases it instead of rewriting the prompt", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.begin("second"));
    await act(() => result.current.save());
    expect(api.finish).toHaveBeenCalledWith("second", "lease-1", { outcome: "cancel" });
  });

  test("a refusal throws its reason and starts no edit", async () => {
    const api = fakeApi();
    api.begin.mockImplementationOnce(
      async () =>
        ({
          status: "refused",
          reason: "held-elsewhere",
          queue: null,
        }) as never,
    );
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(async () => {
      await expect(result.current.begin("second")).rejects.toThrow("another device");
    });
    expect(result.current.session).toBeNull();
  });

  test("a conflicting save keeps the text, and Use mine takes the edit back and commits it", async () => {
    const api = fakeApi();
    api.finish.mockImplementationOnce(async () => ({
      status: "conflict",
      reason: "lease-lost",
      queue: null,
    }));
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.begin("second"));
    act(() => result.current.setText("mine"));
    await act(() => result.current.save());
    expect(result.current.session).toMatchObject({ text: "mine", conflict: "lease-lost" });

    await act(() => result.current.overwrite());
    expect(api.begin).toHaveBeenLastCalledWith("second", { takeOver: true });
    expect(api.finish).toHaveBeenLastCalledWith(
      "second",
      "lease-2",
      expect.objectContaining({ outcome: "commit" }),
    );
    expect(result.current.session).toBeNull();
  });

  test("editing again after a conflict keeps what the person typed", async () => {
    const api = fakeApi();
    api.finish.mockImplementationOnce(async () => ({
      status: "conflict",
      reason: "lease-lost",
      queue: null,
    }));
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.begin("second"));
    act(() => result.current.setText("mine"));
    await act(() => result.current.save());
    await act(() => result.current.begin("second", { takeOver: true }));
    expect(result.current.session).toMatchObject({ leaseId: "lease-2", text: "mine" });
    expect(result.current.session?.conflict).toBeUndefined();
  });

  test("leaving an unchanged edit releases it; leaving a changed one leaves it for review", async () => {
    const unchanged = fakeApi();
    const first = renderHook(() => usePromptQueueEdit(unchanged));
    await act(() => first.result.current.begin("second"));
    first.unmount();
    expect(unchanged.finish).toHaveBeenCalledWith("second", "lease-1", { outcome: "cancel" });

    const edited = fakeApi();
    const second = renderHook(() => usePromptQueueEdit(edited));
    await act(() => second.result.current.begin("second"));
    act(() => second.result.current.setText("half-written"));
    second.unmount();
    expect(edited.finish).not.toHaveBeenCalled();
  });

  test("releasing another client's unfinished edit takes it over and cancels it", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.release("second"));
    expect(api.begin).toHaveBeenCalledWith("second", { takeOver: true });
    expect(api.finish).toHaveBeenCalledWith("second", "lease-1", { outcome: "cancel" });
    expect(result.current.session).toBeNull();
  });

  test("a second edit with unsaved changes elsewhere is refused", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePromptQueueEdit(api));
    await act(() => result.current.begin("second"));
    act(() => result.current.setText("unsaved"));
    await act(async () => {
      await expect(result.current.begin("third")).rejects.toThrow("Save or cancel");
    });
    expect(result.current.session?.messageId).toBe("second");
  });
});
