import { afterEach, describe, expect, test } from "bun:test";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";
import { buildPromptWithTranscriptAnnotations } from "@/lib/chat/transcript-annotations";
import { invokeMock } from "@/test/web-annotation-fakes";
import {
  applyMigratedReferences,
  hasUnmigratedBrowserNotes,
  reconcileComposeDraftValue,
  savedMigrationReferences,
} from "./compose-migration";

afterEach(() => invokeMock.mockImplementation(() => Promise.resolve()));

describe("legacy browser notes in compose drafts", () => {
  const legacy = {
    id: "legacy-1",
    source: "browser" as const,
    text: "button Save",
    comment: "pad",
  };
  const transcript = { id: "t-1", source: "transcript" as const, text: "quoted", comment: "" };

  test("references replace only the migrated notes and their linked attachments", () => {
    const next = applyMigratedReferences(
      [legacy, transcript],
      [{ id: "att-1", annotationId: "legacy-1" }, { id: "att-2" }],
      [{ legacyId: "legacy-1", annotationId: "annotation-7" }],
    );
    expect(next?.annotations[0]).toEqual({
      id: "legacy-1",
      source: "browser",
      text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
      comment: "",
      migratedTo: "annotation-7",
    });
    expect(next?.annotations[1]).toBe(transcript);
    expect(next?.attachments).toEqual([{ id: "att-2" }]);
    expect(hasUnmigratedBrowserNotes(next!.annotations)).toBe(false);
    expect(hasUnmigratedBrowserNotes([legacy])).toBe(true);
  });

  test("migrated references are never sent to an agent", () => {
    const prompt = buildPromptWithTranscriptAnnotations("Hello", [
      { ...legacy, text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT, migratedTo: "annotation-7" },
    ]);
    expect(prompt).toBe("Hello");
  });

  test("reconciliation keeps the user's text and reads references from saves", async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe("web_annotations_reconcile_draft");
      const value = args.value as { text: string };
      return {
        value: { ...value, annotations: [{ ...legacy, migratedTo: "annotation-7" }] },
        references: [{ legacyId: "legacy-1", annotationId: "annotation-7" }],
        imported: 1,
        failed: [],
      };
    });
    const result = await reconcileComposeDraftValue("env-1", {
      text: "my text",
      annotations: [legacy],
    });
    expect(result?.references).toEqual([{ legacyId: "legacy-1", annotationId: "annotation-7" }]);
    invokeMock.mockImplementation(async () => {
      throw new Error("Unknown backend command");
    });
    expect(await reconcileComposeDraftValue("env-1", { text: "x" })).toBeNull();
    expect(
      savedMigrationReferences({
        revision: 2,
        webAnnotationMigration: { references: [{ legacyId: "a", annotationId: "b" }, { bad: 1 }] },
      }),
    ).toEqual([{ legacyId: "a", annotationId: "b" }]);
    expect(savedMigrationReferences({ revision: 2 })).toEqual([]);
  });
});
