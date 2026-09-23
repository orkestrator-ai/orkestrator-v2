import { beforeEach, describe, expect, test } from "bun:test";
import {
  nativeComposePersistenceStore,
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} from "./nativeComposeStore";

describe("nativeComposeStore", () => {
  beforeEach(() => {
    useNativeComposeStore.setState({ drafts: new Map() });
  });

  test("round-trips a provider's own execution profile name", () => {
    const sessionKey = "env-env-1:tab-profile";
    const persistence = unassignedNativeComposePersistenceStore.getState();

    // Execution profiles are the provider's primary-agent names, which users
    // can rename. Narrowing this to the launcher's two defaults would discard a
    // perfectly valid selection on restore.
    persistence.setDraftMetadata?.(sessionKey, {
      platform: "opencode",
      executionProfileId: "custom-reviewer",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      platform: "opencode",
      executionProfileId: "custom-reviewer",
    });

    persistence.setDraftMetadata?.(sessionKey, {
      platform: "opencode",
      executionProfileId: "plan",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      platform: "opencode",
      executionProfileId: "plan",
    });
    expect(
      unassignedNativeComposePersistenceStore.getState().draftMetadata?.get(sessionKey),
    ).toMatchObject({ executionProfileId: "plan" });
  });

  test("rejects execution profile ids that are blank, oversized, or not strings", () => {
    const persistence = unassignedNativeComposePersistenceStore.getState();

    for (const [index, executionProfileId] of [
      "   ",
      "x".repeat(257),
      42,
      { id: "plan" },
      null,
    ].entries()) {
      const sessionKey = `env-env-1:tab-invalid-${index}`;
      persistence.setDraftMetadata?.(sessionKey, {
        platform: "opencode",
        executionProfileId,
      });
      expect(
        useNativeComposeStore.getState().drafts.get(sessionKey)?.executionProfileId,
      ).toBeUndefined();
    }

    // The boundary itself is accepted, so the cap rejects only what exceeds it.
    persistence.setDraftMetadata?.("env-env-1:tab-max", {
      platform: "opencode",
      executionProfileId: "x".repeat(256),
    });
    expect(
      useNativeComposeStore.getState().drafts.get("env-env-1:tab-max")?.executionProfileId,
    ).toBe("x".repeat(256));
  });

  test("restores a draft that carries only an execution profile", () => {
    const sessionKey = "env-env-1:tab-profile-only";
    unassignedNativeComposePersistenceStore.getState().setDraftMetadata?.(sessionKey, {
      executionProfileId: "plan",
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.executionProfileId).toBe(
      "plan",
    );
  });

  test("content edits keep dispatch ownership while a first submission is pending", () => {
    const sessionKey = "env-env-1:tab-pending-edit";
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      text: "original",
      requestId: "request-1",
      submissionPending: true,
      pendingTranscriptConfirmation: {
        requestId: "request-1",
        sessionId: "",
        priorMessageIds: [],
      },
    });

    useNativeComposeStore.getState().updateDraft(sessionKey, {
      text: "typed while pending",
    });

    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      text: "typed while pending",
      requestId: "request-1",
      submissionPending: true,
      pendingTranscriptConfirmation: {
        requestId: "request-1",
        sessionId: "",
        priorMessageIds: [],
      },
    });
  });

  test("locked persistence includes a request id without default-only metadata", () => {
    const sessionKey = "env-env-1:tab-locked-request";
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      text: "pending first prompt",
      requestId: "request-locked",
    });
    expect(nativeComposePersistenceStore.getState().draftMetadata?.get(sessionKey)).toMatchObject({
      requestId: "request-locked",
    });

    const emptyKey = "env-env-1:tab-locked-empty";
    useNativeComposeStore.getState().updateDraft(emptyKey, { text: "just text" });
    expect(nativeComposePersistenceStore.getState().draftMetadata?.has(emptyKey)).toBe(false);
  });

  test("restores request id and transcript confirmation from persisted metadata", () => {
    const sessionKey = "env-env-1:tab-restore-confirmation";
    unassignedNativeComposePersistenceStore.getState().setDraftMetadata?.(sessionKey, {
      requestId: "request-9",
      pendingTranscriptConfirmation: {
        requestId: "request-9",
        sessionId: "",
        priorMessageIds: [],
      },
    });

    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      requestId: "request-9",
      pendingTranscriptConfirmation: {
        requestId: "request-9",
        sessionId: "",
        priorMessageIds: [],
      },
    });
  });

  test("annotation edits invalidate dispatch ownership", () => {
    const sessionKey = "env-env-1:tab-annotations";
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      requestId: "request-1",
      pendingTranscriptConfirmation: {
        requestId: "request-1",
        sessionId: "session-1",
        priorMessageIds: ["older-message"],
      },
    });

    useNativeComposeStore.getState().updateDraft(sessionKey, {
      annotations: [{ id: "reference-1", text: "selected text", comment: "" }],
    });

    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
      annotations: [{ id: "reference-1", text: "selected text", comment: "" }],
    });
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.requestId).toBeUndefined();
    expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.pendingTranscriptConfirmation,
    ).toBeUndefined();
  });

  test("consumes one shared browser annotation across an environment", () => {
    const browserAnnotation = {
      id: "browser-reference",
      source: "browser" as const,
      text: "button#save",
      comment: "Make this clearer",
      screenshotPath: "/workspace/.orkestrator/annotations/save.png",
    };
    const transcriptAnnotation = {
      id: "transcript-reference",
      text: "Earlier answer",
      comment: "Keep this",
    };
    for (const sessionKey of ["env-env-1:tab-a", "env-env-1:tab-b", "env-env-2:tab-c"]) {
      useNativeComposeStore.getState().updateDraft(sessionKey, {
        text: `draft for ${sessionKey}`,
        annotations: [browserAnnotation, transcriptAnnotation],
        attachments: [
          {
            id: `screen-${sessionKey}`,
            annotationId: browserAnnotation.id,
            type: "image",
            path: browserAnnotation.screenshotPath,
            name: "save.png",
          },
        ],
      });
    }

    useNativeComposeStore.getState().consumeBrowserAnnotations("env-1", [browserAnnotation.id]);

    for (const sessionKey of ["env-env-1:tab-a", "env-env-1:tab-b"]) {
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
        text: `draft for ${sessionKey}`,
        annotations: [transcriptAnnotation],
        attachments: [],
      });
    }
    expect(useNativeComposeStore.getState().drafts.get("env-env-2:tab-c")).toMatchObject({
      annotations: [browserAnnotation, transcriptAnnotation],
      attachments: [expect.objectContaining({ annotationId: browserAnnotation.id })],
    });
  });
  describe("command selection", () => {
    const selection = {
      commandId: "claude:/review",
      bindingRevision: "rev-1",
      token: "/review",
      platform: "claude" as const,
      sessionId: "session-1",
    };

    test("survives argument edits byte-for-byte and drops when the token changes", () => {
      const sessionKey = "env-env-1:tab-select";
      const store = useNativeComposeStore.getState();
      store.updateDraft(sessionKey, { text: "/review ", commandSelection: selection });

      for (const text of [
        "/review src/a.ts",
        "/review\tsrc/a.ts  ",
        '/review "quoted"\nsecond line\n',
        "  /review keeps leading space",
      ]) {
        useNativeComposeStore.getState().updateDraft(sessionKey, { text });
        const draft = useNativeComposeStore.getState().drafts.get(sessionKey);
        expect(draft?.text).toBe(text);
        expect(draft?.commandSelection).toEqual(selection);
      }

      for (const text of ["/reviews x", "/reviewx", "review x", "/Review x"]) {
        useNativeComposeStore
          .getState()
          .updateDraft(sessionKey, { text: "/review ", commandSelection: selection });
        useNativeComposeStore.getState().updateDraft(sessionKey, { text });
        expect(
          useNativeComposeStore.getState().drafts.get(sessionKey)?.commandSelection,
        ).toBeUndefined();
      }
    });

    test("an explicit clear wins and non-text edits leave it alone", () => {
      const sessionKey = "env-env-1:tab-select-clear";
      const store = useNativeComposeStore.getState();
      store.updateDraft(sessionKey, { text: "/review ", commandSelection: selection });
      store.updateDraft(sessionKey, { attachments: [] });
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.commandSelection).toEqual(
        selection,
      );
      store.updateDraft(sessionKey, { commandSelection: undefined });
      expect(
        useNativeComposeStore.getState().drafts.get(sessionKey)?.commandSelection,
      ).toBeUndefined();
    });

    test("persists with the draft and restores a valid identity", () => {
      const sessionKey = "env-env-1:tab-select-persist";
      useNativeComposeStore
        .getState()
        .updateDraft(sessionKey, { text: "/review x", commandSelection: selection });
      const metadata = nativeComposePersistenceStore.getState().draftMetadata?.get(sessionKey);
      expect(metadata).toMatchObject({ commandSelection: selection });

      useNativeComposeStore.setState({ drafts: new Map() });
      const persistence = nativeComposePersistenceStore.getState();
      persistence.setDraftText(sessionKey, "/review x");
      persistence.setDraftMetadata?.(sessionKey, metadata);
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.commandSelection).toEqual(
        selection,
      );
    });

    test("refuses malformed persisted identities", () => {
      const persistence = unassignedNativeComposePersistenceStore.getState();
      const bad = [
        { ...selection, commandId: "" },
        { ...selection, commandId: "has space" },
        { ...selection, commandId: "x".repeat(300) },
        { ...selection, token: "review" },
        { ...selection, token: "/re view" },
        { ...selection, bindingRevision: 7 },
        "not an object",
      ];
      bad.forEach((commandSelection, index) => {
        const sessionKey = `env-env-1:tab-bad-${index}`;
        persistence.setDraftMetadata?.(sessionKey, { mode: "build", commandSelection });
        expect(
          useNativeComposeStore.getState().drafts.get(sessionKey)?.commandSelection,
        ).toBeUndefined();
      });
    });
  });
});
