import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";

const invokeMock = invoke as ReturnType<typeof mock>;

const {
  buildInitialPromptWithAttachmentReferences,
  saveInitialPromptAttachments,
} = await import("./initial-prompt-attachments");

describe("saveInitialPromptAttachments", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "write_container_file") {
        return `/workspace/${args.filePath}`;
      }
      if (command === "write_local_file") {
        return `${args.worktreePath}/${args.filePath}`;
      }
      return undefined;
    });
  });

  test("writes container attachments and returns workspace paths", async () => {
    const saved = await saveInitialPromptAttachments({
      containerId: "container-1",
      attachments: [
        {
          id: "img-1",
          name: "screen shot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("write_container_file", {
      containerId: "container-1",
      filePath: ".orkestrator/initial-prompt/screen-shot.png",
      base64Data: "QUJD",
    });
    expect(saved).toEqual([
      {
        name: "screen-shot.png",
        path: "/workspace/.orkestrator/initial-prompt/screen-shot.png",
      },
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_local_file",
      expect.anything(),
    );
  });

  test("writes local attachments and returns absolute local paths", async () => {
    const saved = await saveInitialPromptAttachments({
      containerId: null,
      worktreePath: "/tmp/worktree",
      attachments: [
        {
          id: "img-1",
          name: "local.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("write_local_file", {
      worktreePath: "/tmp/worktree",
      filePath: ".orkestrator/initial-prompt/local.png",
      base64Data: "QUJD",
    });
    expect(saved).toEqual([
      {
        name: "local.png",
        path: "/tmp/worktree/.orkestrator/initial-prompt/local.png",
      },
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_container_file",
      expect.anything(),
    );
  });

  test("requires either a container id or worktree path", async () => {
    await expect(
      saveInitialPromptAttachments({
        containerId: null,
        attachments: [
          {
            id: "img-1",
            name: "missing-target.png",
            previewUrl: "data:image/png;base64,QUJD",
            base64Data: "QUJD",
          },
        ],
      }),
    ).rejects.toThrow("Cannot save initial prompt attachments");
  });

  test("continues saving remaining attachments after one write fails", async () => {
    invokeMock
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async (_command: string, args: Record<string, unknown>) => `/workspace/${args.filePath}`);

    const saved = await saveInitialPromptAttachments({
      containerId: "container-1",
      attachments: [
        {
          id: "img-1",
          name: "failed.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
        {
          id: "img-2",
          name: "saved.png",
          previewUrl: "data:image/png;base64,REVG",
          base64Data: "REVG",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([
      {
        name: "saved.png",
        path: "/workspace/.orkestrator/initial-prompt/saved.png",
      },
    ]);
  });
});

describe("buildInitialPromptWithAttachmentReferences", () => {
  test("appends saved image paths to a text prompt", () => {
    const prompt = buildInitialPromptWithAttachmentReferences("Fix the UI", [
      { name: "screenshot.png", path: "/workspace/.orkestrator/initial-prompt/screenshot.png" },
    ]);

    expect(prompt).toContain("Fix the UI");
    expect(prompt).toContain("Attached images have been saved in the workspace");
    expect(prompt).toContain("- screenshot.png: /workspace/.orkestrator/initial-prompt/screenshot.png");
  });

  test("uses attachment references as the whole prompt when text is blank", () => {
    const prompt = buildInitialPromptWithAttachmentReferences("   ", [
      { name: "only-image.png", path: "/tmp/worktree/.orkestrator/initial-prompt/only-image.png" },
    ]);

    expect(prompt.startsWith("Attached images have been saved in the workspace")).toBe(true);
    expect(prompt).toContain("/tmp/worktree/.orkestrator/initial-prompt/only-image.png");
  });
});
