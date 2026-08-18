import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";

const invokeMock = invoke as ReturnType<typeof mock>;

const { buildInitialPromptWithAttachmentReferences, saveInitialPromptAttachments } =
  await import("./initial-prompt-attachments");

describe("saveInitialPromptAttachments", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([
      { name: "screen-shot.png", path: "/workspace/.orkestrator/initial-prompt/screen-shot.png" },
    ]);
  });

  test("sends the complete attachment batch to the environment-scoped backend command", async () => {
    const saved = await saveInitialPromptAttachments({
      environmentId: "env-1",
      attachments: [
        {
          id: "img-1",
          name: "screen shot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("write_initial_prompt_attachments", {
      environmentId: "env-1",
      attachments: [
        {
          id: "img-1",
          name: "screen shot.png",
          base64Data: "QUJD",
        },
      ],
    });
    expect(saved).toEqual([
      {
        name: "screen-shot.png",
        path: "/workspace/.orkestrator/initial-prompt/screen-shot.png",
      },
    ]);
  });

  test("does not call the backend for an empty batch", async () => {
    await expect(
      saveInitialPromptAttachments({ environmentId: "env-1", attachments: [] }),
    ).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("buildInitialPromptWithAttachmentReferences", () => {
  test("appends saved image paths to a text prompt", () => {
    const prompt = buildInitialPromptWithAttachmentReferences("Fix the UI", [
      { name: "screenshot.png", path: "/workspace/.orkestrator/initial-prompt/screenshot.png" },
    ]);

    expect(prompt).toContain("Fix the UI");
    expect(prompt).toContain("Attached images have been saved in the workspace");
    expect(prompt).toContain(
      "- screenshot.png: /workspace/.orkestrator/initial-prompt/screenshot.png",
    );
  });

  test("uses attachment references as the whole prompt when text is blank", () => {
    const prompt = buildInitialPromptWithAttachmentReferences("   ", [
      { name: "only-image.png", path: "/tmp/worktree/.orkestrator/initial-prompt/only-image.png" },
    ]);

    expect(prompt.startsWith("Attached images have been saved in the workspace")).toBe(true);
    expect(prompt).toContain("/tmp/worktree/.orkestrator/initial-prompt/only-image.png");
  });
});
