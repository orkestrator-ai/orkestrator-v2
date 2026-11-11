import { afterEach, describe, expect, test } from "bun:test";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";
import { buildPromptWithTranscriptAnnotations } from "@/lib/chat/transcript-annotations";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
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

describe("reconciling a draft on another machine's environment", () => {
  const legacy = {
    id: "legacy-remote",
    source: "browser" as const,
    text: "button Save",
    comment: "pad",
  };
  let windowScope: WindowScope;

  afterEach(() => windowScope?.dispose());

  function remoteScope() {
    const client = new FakeNodeClient({ nodeId: "bk_remote-node" as BackendId });
    windowScope = new WindowScope();
    return { client, scope: windowScope.open({ role: "leaf", client }) };
  }

  test("reconciles on the owning node, keeping the user's text", async () => {
    const localCalls: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      localCalls.push(command);
      throw new Error("This window's backend does not know env-remote");
    });
    const { client, scope } = remoteScope();
    client.respond("web_annotations_reconcile_draft", (args: Readonly<Record<string, unknown>>) => {
      const value = args.value as { text: string };
      return {
        value: { ...value, annotations: [{ ...legacy, migratedTo: "annotation-remote" }] },
        references: [{ legacyId: "legacy-remote", annotationId: "annotation-remote" }],
        imported: 1,
        failed: [],
      };
    });

    const result = await reconcileComposeDraftValue(
      "env-remote",
      { text: "my remote text", annotations: [legacy] },
      scope,
    );

    expect(result?.references).toEqual([
      { legacyId: "legacy-remote", annotationId: "annotation-remote" },
    ]);
    expect(result?.annotations).toEqual([{ ...legacy, migratedTo: "annotation-remote" }]);
    expect(client.calls("web_annotations_reconcile_draft")[0]!.args).toMatchObject({
      environmentId: "env-remote",
      value: { text: "my remote text", annotations: [legacy] },
    });
    expect(localCalls).toEqual([]);
  });

  test("a failure on the owning node leaves the draft untouched", async () => {
    const localCalls: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      localCalls.push(command);
      return { value: { text: "wrong node" }, references: [] };
    });
    const { client, scope } = remoteScope();
    client.respond("web_annotations_reconcile_draft", () => {
      throw new Error("Gateway disconnected");
    });
    const draft = { text: "keep me", annotations: [legacy] };

    expect(await reconcileComposeDraftValue("env-remote", draft, scope)).toBeNull();
    expect(draft).toEqual({ text: "keep me", annotations: [legacy] });
    expect(hasUnmigratedBrowserNotes(draft.annotations)).toBe(true);
    expect(client.calls("web_annotations_reconcile_draft")).toHaveLength(1);
    expect(localCalls).toEqual([]);
  });
});
