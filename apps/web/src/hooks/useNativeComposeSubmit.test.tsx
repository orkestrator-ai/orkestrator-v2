import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { mockToastError } from "../../../../tests/mocks/sonner";
import type { FileMention } from "@/types";
import { useNativeComposeSubmit } from "./useNativeComposeSubmit";

const SESSION_KEY = "env-env-1:tab-1";
const MENTION: FileMention = {
  id: "mention-1",
  filename: "file.ts",
  relativePath: "src/file.ts",
};

interface Attachment {
  id: string;
  name: string;
}

function createDraftStore(text = "", mentions: FileMention[] = []) {
  let draftText = text;
  let draftMentions = mentions;
  const removedAttachmentIds: string[] = [];

  return {
    store: {
      getState: () => ({
        getDraftText: () => draftText,
        getDraftMentions: () => draftMentions,
        setDraftText: (_sessionKey: string, next: string) => {
          draftText = next;
        },
        setDraftMentions: (_sessionKey: string, next: FileMention[]) => {
          draftMentions = next;
        },
        removeAttachment: (_sessionKey: string, attachmentId: string) => {
          removedAttachmentIds.push(attachmentId);
        },
      }),
    },
    getDraftText: () => draftText,
    getDraftMentions: () => draftMentions,
    setDraft: (nextText: string, nextMentions = draftMentions) => {
      draftText = nextText;
      draftMentions = nextMentions;
    },
    removedAttachmentIds,
  };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  const draft = createDraftStore(" hello ", [MENTION]);
  const onSend = mock(async () => {});
  const serializeForLLM = mock((text: string) => `serialized:${text}`);
  return {
    draft,
    options: {
      agentLabel: "Test",
      sessionKey: SESSION_KEY,
      store: draft.store,
      text: " hello ",
      mentions: [MENTION],
      attachments: [] as Attachment[],
      serializeForLLM,
      onSend,
      isLoading: false,
      ...overrides,
    },
    onSend,
    serializeForLLM,
  };
}

afterEach(() => {
  cleanup();
  mockToastError.mockClear();
});

describe("useNativeComposeSubmit", () => {
  test("serializes, sends, and clears the unchanged draft", async () => {
    const setup = makeOptions();
    const { result } = renderHook(() =>
      useNativeComposeSubmit<Attachment>(setup.options),
    );

    await act(async () => {
      await result.current.submit();
    });

    expect(setup.serializeForLLM).toHaveBeenCalledWith("hello", [MENTION]);
    expect(setup.onSend).toHaveBeenCalledWith("serialized:hello", []);
    expect(setup.draft.getDraftText()).toBe("");
    expect(setup.draft.getDraftMentions()).toEqual([]);
    expect(result.current.isSending).toBe(false);
  });

  test("sends an attachment-only draft and removes submitted attachments", async () => {
    const attachment = { id: "attachment-1", name: "image.png" };
    const draft = createDraftStore("");
    const onSend = mock(async () => {});
    const { result } = renderHook(() =>
      useNativeComposeSubmit<Attachment>({
        agentLabel: "Test",
        sessionKey: SESSION_KEY,
        store: draft.store,
        text: "   ",
        mentions: [],
        attachments: [attachment],
        serializeForLLM: (text) => text,
        onSend,
        isLoading: false,
      }),
    );

    await act(async () => {
      await result.current.submit();
    });

    expect(onSend).toHaveBeenCalledWith("", [attachment]);
    expect(draft.removedAttachmentIds).toEqual(["attachment-1"]);
  });

  test("queues while loading and reports a queue failure", async () => {
    const queueError = new Error("queue unavailable");
    const onQueue = mock(async () => {
      throw queueError;
    });
    const setup = makeOptions({ isLoading: true, onQueue });
    const consoleError = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleError;

    try {
      const { result } = renderHook(() =>
        useNativeComposeSubmit<Attachment>(setup.options),
      );
      await act(async () => {
        await result.current.submit();
      });

      expect(onQueue).toHaveBeenCalledWith("serialized:hello", []);
      expect(setup.onSend).not.toHaveBeenCalled();
      expect(setup.draft.getDraftText()).toBe(" hello ");
      expect(mockToastError).toHaveBeenCalledWith("Failed to queue prompt");
      expect(consoleError).toHaveBeenCalledWith(
        "[TestComposeBar] Failed to queue prompt:",
        queueError,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("preserves text typed during send but removes submitted attachments", async () => {
    const attachment = { id: "attachment-1", name: "image.png" };
    let resolveSend!: () => void;
    const onSend = mock(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const setup = makeOptions({ attachments: [attachment], onSend });
    const { result } = renderHook(() =>
      useNativeComposeSubmit<Attachment>(setup.options),
    );

    let submission!: Promise<void>;
    act(() => {
      submission = result.current.submit();
    });
    setup.draft.setDraft("new text", []);
    await act(async () => {
      resolveSend();
      await submission;
    });

    expect(setup.draft.getDraftText()).toBe("new text");
    expect(setup.draft.getDraftMentions()).toEqual([]);
    expect(setup.draft.removedAttachmentIds).toEqual(["attachment-1"]);
  });

  test("refuses empty, disabled, vetoed, and unsupported busy submissions", async () => {
    const onSend = mock(async () => {});
    const empty = makeOptions({ text: " ", mentions: [], onSend });
    const disabled = makeOptions({ disabled: true, onSend });
    const vetoed = makeOptions({ canSubmit: () => false, onSend });
    const busy = makeOptions({
      isLoading: true,
      refuseWhenBusyWithoutQueue: true,
      onSend,
    });
    const hooks = [
      renderHook(() => useNativeComposeSubmit<Attachment>(empty.options)),
      renderHook(() => useNativeComposeSubmit<Attachment>(disabled.options)),
      renderHook(() => useNativeComposeSubmit<Attachment>(vetoed.options)),
      renderHook(() => useNativeComposeSubmit<Attachment>(busy.options)),
    ];

    for (const hook of hooks) {
      await act(async () => {
        await hook.result.current.submit();
      });
    }

    expect(onSend).not.toHaveBeenCalled();
  });

  test("prevents a second submission while the first is in flight", async () => {
    let resolveSend!: () => void;
    const onSend = mock(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const setup = makeOptions({ onSend });
    const { result } = renderHook(() =>
      useNativeComposeSubmit<Attachment>(setup.options),
    );

    let first!: Promise<void>;
    act(() => {
      first = result.current.submit();
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend();
      await first;
    });
  });

  test("submitPrompt sends only when idle and surfaces failures", async () => {
    const promptError = new Error("send unavailable");
    const onSend = mock(async () => {
      throw promptError;
    });
    const setup = makeOptions({ onSend });
    const consoleError = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleError;

    try {
      const active = renderHook(() =>
        useNativeComposeSubmit<Attachment>(setup.options),
      );
      await act(async () => {
        await active.result.current.submitPrompt("Address all");
      });
      expect(onSend).toHaveBeenCalledWith("Address all", []);
      expect(mockToastError).toHaveBeenCalledWith("Failed to send prompt");
      expect(consoleError).toHaveBeenCalledWith(
        "[TestComposeBar] Failed to send review follow-up:",
        promptError,
      );

      onSend.mockClear();
      const disabled = makeOptions({ disabled: true, onSend });
      const loading = makeOptions({ isLoading: true, onSend });
      const hooks = [
        renderHook(() => useNativeComposeSubmit<Attachment>(disabled.options)),
        renderHook(() => useNativeComposeSubmit<Attachment>(loading.options)),
      ];
      for (const hook of hooks) {
        await act(async () => {
          await hook.result.current.submitPrompt("Address all");
        });
      }
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
