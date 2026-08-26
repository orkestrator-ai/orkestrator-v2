import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES } from "@orkestrator/protocol/initial-prompt-attachments";
import { isInitialPromptImageAttachment } from "./storage-shared-core.js";
import { createEnvironment, StorageService } from "./storage.js";

async function withStorage(
  run: (storage: StorageService, environmentId: string) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-initial-attachments-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    await run(storage, environment.id);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("initial prompt attachment storage", () => {
  test("accepts legacy, image, and file kinds while rejecting unknown kinds", () => {
    expect(
      isInitialPromptImageAttachment({ id: "legacy", name: "legacy.png", base64Data: "QUJD" }),
    ).toBe(true);
    expect(
      isInitialPromptImageAttachment({
        id: "image",
        name: "image.png",
        type: "image",
        base64Data: "QUJD",
      }),
    ).toBe(true);
    expect(
      isInitialPromptImageAttachment({
        id: "file",
        name: "notes.md",
        type: "file",
        base64Data: "QUJD",
      }),
    ).toBe(true);
    expect(
      isInitialPromptImageAttachment({
        id: "unknown",
        name: "unknown.bin",
        type: "archive",
        base64Data: "QUJD",
      }),
    ).toBe(false);
  });

  test("round-trips file kinds and strips previews before measuring and persisting", async () => {
    await withStorage(async (storage, environmentId) => {
      const base64Data = "A".repeat(MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES - 256);
      const updated = await storage.updateEnvironment(environmentId, {
        initialPromptAttachments: [
          {
            id: "large-file",
            name: "requirements.bin",
            type: "file",
            previewUrl: `data:application/octet-stream;base64,${base64Data}`,
            base64Data,
          },
        ],
      });

      expect(updated.initialPromptAttachments).toEqual([
        {
          id: "large-file",
          name: "requirements.bin",
          type: "file",
          base64Data,
        },
      ]);
      expect((await storage.getEnvironment(environmentId))?.initialPromptAttachments?.[0]).toEqual({
        id: "large-file",
        name: "requirements.bin",
        type: "file",
        base64Data,
      });
    });
  });

  test("rejects a durable attachment array above the shared storage limit", async () => {
    await withStorage(async (storage, environmentId) => {
      await expect(
        storage.updateEnvironment(environmentId, {
          initialPromptAttachments: [
            {
              id: "oversized",
              name: "oversized.bin",
              type: "file",
              base64Data: "A".repeat(MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES),
            },
          ],
        }),
      ).rejects.toThrow("Initial prompt attachments exceed the 32 MB limit");
      expect(
        (await storage.getEnvironment(environmentId))?.initialPromptAttachments,
      ).toBeUndefined();
    });
  });
});
