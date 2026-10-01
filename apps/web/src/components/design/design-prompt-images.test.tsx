import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { mockReadImage } from "../../../../../tests/mocks/clipboard";
import { toast } from "sonner";
// Registered once in tests/setup.ts; this file only varies its behavior.
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import type { Environment } from "@/types";
import {
  deferred,
  dispatchImagePaste,
  installImagePasteSupport,
  pasteImage,
  settlePaste,
} from "./design-paste-test-support";
import {
  DesignPromptImages,
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

function Harness({
  enabled = true,
  onChange,
  initial = [],
  environmentId = "env-1",
  scopeKey = "backend-a",
}: {
  enabled?: boolean;
  onChange?: () => void;
  initial?: DesignPromptImage[];
  environmentId?: string;
  scopeKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<DesignPromptImage[]>(initial);
  const paste = useDesignPromptImagePaste({
    containerRef: ref,
    environmentId,
    scopeKey,
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
      <button disabled={paste.isPasting} onClick={() => paste.tryBeginSubmission()}>
        Submit
      </button>
      <button onClick={paste.endSubmission}>Unlock</button>
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
  test("restores native text paste at the image cap without an image rejection toast", async () => {
    seedEnvironment();
    render(
      <Harness
        initial={Array.from({ length: DESIGN_PROMPT_IMAGE_LIMIT }, (_, i) => image(`seed-${i}`))}
      />,
    );
    const original = window.orkestratorGateway;
    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    window.orkestratorGateway = { ...original, desktop: true } as typeof original;
    mockReadImage.mockImplementationOnce(async () => {
      throw new Error("no image");
    });
    const errors = mockToastError.mock.calls.length;
    try {
      prompt.focus();
      act(() =>
        fireEvent.paste(prompt, {
          clipboardData: { items: [], files: [], getData: () => "ordinary text" },
        }),
      );
      await settlePaste();
      expect(prompt.value).toBe("ordinary text");
      expect(mockToastError.mock.calls.length).toBe(errors);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      window.orkestratorGateway = original;
    }
  });

  test("tracks decoding before a write starts and releases capacity when decoding fails", async () => {
    seedEnvironment();
    const read = deferred<Awaited<ReturnType<typeof mockReadImage>>>();
    mockReadImage.mockImplementationOnce(() => read.promise);
    render(<Harness />);
    act(() => dispatchImagePaste(screen.getByRole("textbox", { name: "Prompt" })));
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => read.reject(new Error("no image")));
    expect(submit.disabled).toBe(false);
    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  test("reserves the last slot before decoding and releases it after a failed write", async () => {
    seedEnvironment();
    const write = deferred<string>();
    invokeMock.mockImplementation(() => write.promise);
    render(
      <Harness
        initial={Array.from({ length: DESIGN_PROMPT_IMAGE_LIMIT - 1 }, (_, i) =>
          image(`seed-${i}`),
        )}
      />,
    );
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    act(() => {
      dispatchImagePaste(prompt);
      dispatchImagePaste(prompt);
    });
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await settlePaste();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Too many images", expect.anything());
    await act(async () => write.reject(new Error("write failed")));
    expect(toast.error).toHaveBeenCalledWith("Cannot paste image", expect.anything());
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    invokeMock.mockImplementation(async () => "/tmp/wt/retry.png");
    await pasteImage(prompt);
    expect(screen.getAllByRole("listitem")).toHaveLength(DESIGN_PROMPT_IMAGE_LIMIT);
    invokeMock.mockClear();
    await pasteImage(prompt);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("only one overlapping write is admitted at limit minus one", async () => {
    seedEnvironment();
    const write = deferred<string>();
    invokeMock.mockImplementation(() => write.promise);
    render(
      <Harness
        initial={Array.from({ length: DESIGN_PROMPT_IMAGE_LIMIT - 1 }, (_, i) =>
          image(`seed-${i}`),
        )}
      />,
    );
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await pasteImage(prompt);
    await pasteImage(prompt);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve("/tmp/wt/final.png"));
    expect(screen.getAllByRole("listitem")).toHaveLength(DESIGN_PROMPT_IMAGE_LIMIT);
  });

  for (const changed of ["environment", "backend", "unmount"] as const) {
    test(`discards old-scope writes after ${changed} changes`, async () => {
      seedEnvironment();
      const old = deferred<string>();
      invokeMock.mockImplementationOnce(() => old.promise);
      const onChange = mock(() => {});
      const view = render(<Harness onChange={onChange} />);
      await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));
      if (changed === "environment") {
        act(() => seedEnvironment({ id: "env-2", worktreePath: "/tmp/other" }));
        view.rerender(<Harness environmentId="env-2" onChange={onChange} />);
      } else if (changed === "backend")
        view.rerender(<Harness scopeKey="backend-b" onChange={onChange} />);
      else view.unmount();
      onChange.mockClear();
      if (changed !== "unmount") {
        await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(1);
        onChange.mockClear();
      }
      await act(async () => old.resolve("/tmp/wt/old.png"));
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByText("/tmp/wt/old.png") === null).toBe(true);
      if (changed !== "unmount") expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
  }

  test("freezes new pastes synchronously while submission owns the images", async () => {
    seedEnvironment();
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      dispatchImagePaste(screen.getByRole("textbox", { name: "Prompt" }));
    });
    await settlePaste();
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  test("renders an always visible, keyboard accessible image removal control", () => {
    const onRemove = mock();
    render(<DesignPromptImages images={[image("shot")]} onRemove={onRemove} />);
    const button = screen.getByRole("button", { name: "Remove shot.png" });
    expect(button.className).not.toContain("opacity-0");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onRemove).toHaveBeenCalledWith("shot");
  });

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

  test("keeps submission disabled until a container image write finishes", async () => {
    seedEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "c1",
    });
    const write = deferred<void>();
    invokeMock.mockImplementation(() => write.promise);
    render(<Harness />);
    await pasteImage(screen.getByRole("textbox", { name: "Prompt" }));
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(invokeMock.mock.calls[0]![0]).toBe("write_container_file");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    await act(async () => write.resolve());
    expect(submit.disabled).toBe(false);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")[0]!.textContent).toStartWith(
      "/workspace/.orkestrator/clipboard/",
    );
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
