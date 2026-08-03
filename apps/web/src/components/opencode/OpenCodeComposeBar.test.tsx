import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { createSessionKey } from "@/lib/utils";
import type { OpenCodeModel } from "@/lib/opencode-client";
import type { FileCandidate } from "@/types";
import type { NativeAttachmentFileSearch } from "@/components/chat/NativeAttachmentMenu";
import type { PastedImageAttachment } from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { OpenCodeComposeBar } from "./OpenCodeComposeBar";
import { mockToastError } from "../../../../../tests/mocks/sonner";

const ENV_ID = "opencode-env";
const TAB_ID = "opencode-tab";
const SESSION_KEY = createSessionKey(ENV_ID, TAB_ID);

const VISION_MODEL: OpenCodeModel = {
  id: "provider/vision",
  name: "Vision Model",
  provider: "provider",
  supportsImageInput: true,
};
const NON_VISION_MODEL: OpenCodeModel = {
  id: "provider/nonvision",
  name: "Non-Vision Model",
  provider: "provider",
  supportsImageInput: false,
};
const UNKNOWN_CAPABILITY_MODEL: OpenCodeModel = {
  id: "provider/unknown-cap",
  name: "Unknown Capability",
  provider: "provider",
};
const MODELS: OpenCodeModel[] = [VISION_MODEL, NON_VISION_MODEL, UNKNOWN_CAPABILITY_MODEL];

const noop = () => {};
const noopAsync = async () => {};

const IMAGE_ATTACHMENT: PastedImageAttachment = {
  id: "att-1",
  type: "image",
  path: "/tmp/env/.orkestrator/clipboard/clipboard.png",
  previewUrl: "data:image/png;base64,QUJD",
  name: "clipboard.png",
};
const NON_IMAGE_ATTACHMENT = { type: "file" } as unknown as PastedImageAttachment;

const IMAGE_FILE: FileCandidate = {
  filename: "shot.png",
  relativePath: "docs/shot.png",
  isDirectory: false,
  extension: ".png",
};

const mockReadContainerFileBase64 = mock(async () => "aGVsbG8=");
const mockReadFileBase64 = mock(async () => "aGVsbG8=");

import * as realBackend from "@/lib/backend";
mock.module("@/lib/backend", () => ({
  ...realBackend,
  readContainerFileBase64: mockReadContainerFileBase64,
  readFileBase64: mockReadFileBase64,
}));

let capturedPasteOptions:
  | Parameters<typeof useNativeComposeBarPaste>[0]
  | undefined;

let fileSearchForTest: NativeAttachmentFileSearch;
mock.module("@/hooks", () => ({
  useFileMentions: () => ({
    isMenuOpen: false,
    selectedIndex: 0,
    filteredFiles: [],
    handleCursorChange: () => {},
    handleKeyDown: () => false,
    closeMenu: () => {},
    serializeForLLM: (text: string) => text,
    createMention: () => null,
  }),
  useFileSearch: () => fileSearchForTest,
  useMediaQuery: () => false,
  useNativeComposeBarPaste: (options: Parameters<typeof useNativeComposeBarPaste>[0]) => {
    capturedPasteOptions = options;
  },
}));

mock.module("@/hooks/useSlashCommandMenu", () => ({
  useSlashCommandMenu: () => ({
    isOpen: false,
    selectedIndex: 0,
    filteredCommands: [],
    selectCommand: () => {},
    closeMenu: () => {},
    handleKeyDown: () => false,
  }),
}));

mock.module("@/hooks/useNativeComposeSubmit", () => ({
  useNativeComposeSubmit: () => ({
    isSending: false,
    submit: mock(() => {}),
    submitPrompt: mock(async () => {}),
  }),
}));

mock.module("@/hooks/usePromptQueueDispatchRecovery", () => ({
  usePromptQueueDispatchRecovery: () => ({ dispatchError: null }),
}));

function createFileSearchForTest(): NativeAttachmentFileSearch {
  return {
    searchFiles: (query) => {
      const normalized = query.toLowerCase();
      return !normalized || IMAGE_FILE.relativePath.toLowerCase().includes(normalized)
        ? [IMAGE_FILE]
        : [];
    },
    isLoading: false,
    error: null,
    refresh: mock(() => {}),
    isAvailable: true,
  };
}

function renderComposeBar(models: OpenCodeModel[], selectedModelId?: string) {
  capturedPasteOptions = undefined;
  // `""` is falsy, so the compose bar treats it exactly like "no model chosen".
  useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, selectedModelId ?? "");
  return render(
    <OpenCodeComposeBar
      environmentId={ENV_ID}
      tabId={TAB_ID}
      containerId="container-1"
      models={models}
      onSend={noop}
      onQueue={noopAsync}
      onStop={noop}
    />,
  );
}

beforeEach(() => {
  capturedPasteOptions = undefined;
  fileSearchForTest = createFileSearchForTest();
  mockReadContainerFileBase64.mockClear();
  mockReadFileBase64.mockClear();
});

afterEach(() => {
  cleanup();
  useOpenCodeStore.getState().clearAttachments(SESSION_KEY);
  useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "");
});

describe("OpenCodeComposeBar image-input gating", () => {
  test("exposes the image-support decision to the paste gate", () => {
    renderComposeBar(MODELS, NON_VISION_MODEL.id);
    const canAttachImage = capturedPasteOptions?.canAttachImage;
    expect(canAttachImage).toBeDefined();
    expect(canAttachImage?.(IMAGE_ATTACHMENT)).toBe(false);
    expect(canAttachImage?.(NON_IMAGE_ATTACHMENT)).toBe(true);
  });

  test("lets image attachments through for a vision-capable model", () => {
    renderComposeBar(MODELS, VISION_MODEL.id);
    expect(capturedPasteOptions?.canAttachImage?.(IMAGE_ATTACHMENT)).toBe(true);
  });

  test("lets image attachments through when capability is unknown", () => {
    renderComposeBar(MODELS, UNKNOWN_CAPABILITY_MODEL.id);
    expect(capturedPasteOptions?.canAttachImage?.(IMAGE_ATTACHMENT)).toBe(true);
  });

  test("lets image attachments through for an unknown model id", () => {
    renderComposeBar(MODELS, "provider/not-in-catalog");
    expect(capturedPasteOptions?.canAttachImage?.(IMAGE_ATTACHMENT)).toBe(true);
  });

  test("lets image attachments through when no model is selected", () => {
    renderComposeBar(MODELS);
    expect(capturedPasteOptions?.canAttachImage?.(IMAGE_ATTACHMENT)).toBe(true);
  });

  test("lets image attachments through for the default-model sentinel", () => {
    renderComposeBar(MODELS, "default");
    expect(capturedPasteOptions?.canAttachImage?.(IMAGE_ATTACHMENT)).toBe(true);
  });

  test("explains a rejected image paste via onImageRejected", () => {
    renderComposeBar(MODELS, NON_VISION_MODEL.id);
    expect(capturedPasteOptions?.onImageRejected).toBeDefined();
    capturedPasteOptions?.onImageRejected?.();
    expect(mockToastError).toHaveBeenCalledWith("Model cannot read images", expect.anything());
  });

  test("adds a pasted attachment once the gate allows it", () => {
    renderComposeBar(MODELS, VISION_MODEL.id);
    const attachment = {
      id: "paste-1",
      type: "image" as const,
      path: "/tmp/env/.orkestrator/clipboard/clipboard.png",
      previewUrl: "data:image/png;base64,QUJD",
      name: "clipboard.png",
    };
    capturedPasteOptions?.onAttach?.(attachment);
    expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toEqual([attachment]);
  });

  test("blocks a workspace image pick when the model cannot read images", async () => {
    renderComposeBar(MODELS, NON_VISION_MODEL.id);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
    );
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /shot\.png/ }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Model cannot read images", expect.anything()));
    expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(0);
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
  });

  test("attaches a workspace image when the model can read images", async () => {
    renderComposeBar(MODELS, VISION_MODEL.id);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
    );
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /shot\.png/ }));

    await waitFor(() =>
      expect(useOpenCodeStore.getState().getAttachments(SESSION_KEY)).toHaveLength(1),
    );
    const [attachment] = useOpenCodeStore.getState().getAttachments(SESSION_KEY);
    expect(attachment).toMatchObject({
      type: "image",
      name: "shot.png",
      path: "/workspace/docs/shot.png",
      previewUrl: "data:image/png;base64,aGVsbG8=",
    });
    expect(mockReadContainerFileBase64).toHaveBeenCalledWith("container-1", "docs/shot.png");
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
