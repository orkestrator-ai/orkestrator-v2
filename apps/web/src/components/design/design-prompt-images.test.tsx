import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { useRef, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
// Registered once in tests/setup.ts; this file only varies its behavior.
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import type { Environment } from "@/types";
import { installImagePasteSupport, pasteImage } from "./design-paste-test-support";
import {
  addDesignImagesToDraft,
  DESIGN_PROMPT_IMAGE_LIMIT,
  useDesignPromptImagePaste,
  type DesignPromptImage,
} from "./design-prompt-images";

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: Record<string, unknown>) => Promise<unknown>
>;

function image(id: string): DesignPromptImage {
  return { id, type: "image", path: `/tmp/wt/.orkestrator/clipboard/${id}.png`, name: `${id}.png` };
}

function seedEnvironment(overrides: Partial<Environment> = {}) {
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        containerId: null,
        status: "running",
        environmentType: "local",
        worktreePath: "/tmp/wt",
        ...overrides,
      } as Environment,
    ],
  });
}

function Harness({ enabled = true, onChange }: { enabled?: boolean; onChange?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<DesignPromptImage[]>([]);
  useDesignPromptImagePaste({
    containerRef: ref,
    environmentId: "env-1",
    enabled,
    images,
    onImagesChange: (next) => {
      onChange?.();
      setImages(next);
    },
  });
  return (
    <>
      <div ref={ref}>
        <textarea aria-label="Prompt" />
      </div>
      <textarea aria-label="Elsewhere" />
      <ul aria-label="Images">
        {images.map((entry) => (
          <li key={entry.id}>{entry.path}</li>
        ))}
      </ul>
    </>
  );
}

let restorePaste: () => void = () => undefined;

beforeEach(() => {
  restorePaste = installImagePasteSupport();
  useNativeComposeStore.setState({ drafts: new Map() });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) =>
    command === "write_local_file" ? `${args?.worktreePath}/${args?.filePath}` : undefined,
  );
});

afterEach(() => {
  cleanup();
  restorePaste();
  useEnvironmentStore.setState({ environments: [] });
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("addDesignImagesToDraft", () => {
  test("appends images to the draft without duplicating ones already there", () => {
    const key = "env-1:tab-1";
    useNativeComposeStore.getState().updateDraft(key, { text: "keep", attachments: [image("a")] });

    expect(addDesignImagesToDraft(key, [image("a"), image("b")])).toBe(true);

    const draft = nativeComposeDraft(useNativeComposeStore.getState(), key);
    expect(draft.text).toBe("keep");
    expect(draft.attachments.map((attachment) => attachment.id)).toEqual(["a", "b"]);
  });

  test("refuses, changing nothing, when the draft would exceed the attachment limit", () => {
    const key = "env-1:tab-1";
    const full = Array.from({ length: DESIGN_PROMPT_IMAGE_LIMIT }, (_, index) =>
      image(`i${index}`),
    );
    useNativeComposeStore.getState().updateDraft(key, { attachments: full });

    expect(addDesignImagesToDraft(key, [image("extra")])).toBe(false);
    expect(nativeComposeDraft(useNativeComposeStore.getState(), key).attachments).toHaveLength(
      DESIGN_PROMPT_IMAGE_LIMIT,
    );
  });
});

describe("useDesignPromptImagePaste", () => {
  test("writes a pasted image into the worktree and attaches it", async () => {
    seedEnvironment();
    render(<Harness />);

    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));

    const write = invokeMock.mock.calls.find(([command]) => command === "write_local_file");
    expect(write?.[1]).toMatchObject({ worktreePath: "/tmp/wt", base64Data: "cG5n" });
    expect(String(write?.[1]?.filePath)).toMatch(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toStartWith("/tmp/wt/.orkestrator/clipboard/");
  });

  test("ignores pastes outside the prompt", async () => {
    seedEnvironment();
    const onChange = mock(() => {});
    render(<Harness onChange={onChange} />);

    await pasteImage(screen.getByRole("textbox", { name: "Elsewhere" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([command]) => command === "write_local_file")).toBe(false);
  });

  test("explains instead of writing when the environment cannot receive files", async () => {
    seedEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
      containerId: "c1",
    });
    const onChange = mock(() => {});
    render(<Harness onChange={onChange} />);

    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith("Start this environment to attach images");
  });

  test("writes into a running container", async () => {
    seedEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "c1",
    });
    invokeMock.mockImplementation(async (command, args) =>
      command === "write_container_file" ? `/workspace/${args?.filePath}` : undefined,
    );
    render(<Harness />);

    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));

    expect(invokeMock.mock.calls.some(([command]) => command === "write_container_file")).toBe(
      true,
    );
    expect(screen.getAllByRole("listitem")[0]!.textContent).toStartWith(
      "/workspace/.orkestrator/clipboard/",
    );
  });
});
