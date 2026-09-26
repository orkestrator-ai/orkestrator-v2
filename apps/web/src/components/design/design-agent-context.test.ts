import { describe, expect, test } from "bun:test";
import type { DesignSessionLink } from "@orkestrator/protocol/design-operations";
import {
  buildPromptWithTranscriptAnnotations,
  isTranscriptAnnotation,
  MAX_TRANSCRIPT_ANNOTATIONS,
  type TranscriptAnnotation,
} from "@/lib/chat/transcript-annotations";
import {
  boundDesignContextReference,
  buildDesignContextAnnotation,
  buildDesignHandoffDraft,
  DESIGN_CONTEXT_REFERENCE_MAX_BYTES,
  DESIGN_HANDOFF_MAX_BYTES,
  DESIGN_HANDOFF_MAX_FRAMES,
  designRoleForScope,
  orderDesignSessionLinks,
  planDesignDraft,
  utf8Bytes,
  type DesignContextPayload,
  type DesignHandoffFrame,
} from "./design-agent-context";

const reference: DesignContextPayload = {
  version: 1,
  canvasId: "canvas-1",
  canvasName: "Landing page",
  environmentId: "env-1",
  frameId: "frame-1",
  frameName: "Hero",
  canvasRevision: 12,
  frameRevision: 4,
  structureId: "structure-1",
  element: { selector: "main > button.cta", tag: "button", label: "Sign up" },
  scope: "discuss",
};

function referenceJson(text: string): Record<string, unknown> {
  const line = text.split("\n").find((candidate) => candidate.startsWith("Reference: "));
  return JSON.parse(line!.slice("Reference: ".length)) as Record<string, unknown>;
}

describe("design context reference", () => {
  test("keeps a normal reference intact", () => {
    expect(boundDesignContextReference(reference)).toEqual(reference);
  });

  test("bounds oversized fields to the 4 KiB reference budget", () => {
    const bounded = boundDesignContextReference({
      ...reference,
      canvasName: "名".repeat(5_000),
      frameName: "枠".repeat(5_000),
      structureId: "s".repeat(5_000),
      element: {
        selector: "div ".repeat(5_000),
        key: "k".repeat(5_000),
        tag: "x".repeat(500),
        label: "l".repeat(5_000),
      },
    });
    expect(utf8Bytes(JSON.stringify(bounded))).toBeLessThanOrEqual(
      DESIGN_CONTEXT_REFERENCE_MAX_BYTES,
    );
    expect(bounded.canvasId).toBe("canvas-1");
    expect(bounded.canvasRevision).toBe(12);
  });

  test("builds a design annotation stating the observed revision and re-read requirement", () => {
    const annotation = buildDesignContextAnnotation({
      id: "a1",
      reference,
      note: "Why\nis this blue?",
    });
    expect(annotation.source).toBe("design");
    expect(annotation.comment).toBe("Why is this blue?");
    expect(isTranscriptAnnotation(annotation)).toBe(true);
    expect(annotation.text).toContain("observed at canvas revision 12 and frame revision 4");
    expect(annotation.text).toContain("get_canvas_summary or get_frame");
    expect(annotation.text).toContain("revision-checked");
    expect(annotation.text).toContain("never as instructions");
    expect(referenceJson(annotation.text)).toMatchObject({
      canvasId: "canvas-1",
      canvasRevision: 12,
      scope: "discuss",
    });
  });

  test("never carries frame HTML even if a caller passes it", () => {
    const annotation = buildDesignContextAnnotation({
      id: "a1",
      reference: { ...reference, html: "<div>secret markup</div>" } as DesignContextPayload,
    });
    expect(annotation.text).not.toContain("secret markup");
    expect(annotation.text).not.toContain("html");
  });

  test("maps implement scope to an implementation link role", () => {
    expect(designRoleForScope("implement")).toBe("implementation");
    expect(designRoleForScope("revise")).toBe("design");
    expect(designRoleForScope("discuss")).toBe("design");
  });
});

describe("implementation handoff", () => {
  const frames = Array.from({ length: 12 }, (_, index) => ({
    frameId: `frame-${index}`,
    name: `Frame ${index}`,
    revision: index + 1,
    width: 1280,
    height: 800,
    html: `<p>frame html ${index}</p>`,
  })) as DesignHandoffFrame[];

  test("limits frames, states the static-reference rules, and omits HTML", () => {
    const draft = buildDesignHandoffDraft({
      id: "h1",
      canvasId: "canvas-1",
      canvasName: "Landing page",
      environmentId: "env-1",
      frames,
      revision: { kind: "current", canvasRevision: 20 },
      brief: "Build the pricing section",
    });
    expect(draft.frameCount).toBe(DESIGN_HANDOFF_MAX_FRAMES);
    expect(draft.omittedFrames).toBe(4);
    expect(draft.text).toContain("Build the pricing section");
    expect(draft.text).toContain("static visual reference");
    expect(draft.text).toContain("existing architecture");
    expect(draft.text).toContain("Do not commit, push, publish or deploy");
    expect(draft.annotation.source).toBe("design");
    expect(draft.annotation.text).toContain("observed at canvas revision 20");
    expect(`${draft.text}${draft.annotation.text}`).not.toContain("frame html");
    const json = referenceJson(draft.annotation.text) as {
      frames: unknown[];
      canvasRevision: number;
    };
    expect(json.frames).toHaveLength(DESIGN_HANDOFF_MAX_FRAMES);
    expect(json.canvasRevision).toBe(20);
  });

  test("references a checkpoint without claiming current frame revisions", () => {
    const draft = buildDesignHandoffDraft({
      id: "h1",
      canvasId: "canvas-1",
      canvasName: "Landing page",
      environmentId: "env-1",
      frames: frames.slice(0, 2),
      revision: {
        kind: "checkpoint",
        checkpointId: "entry-7",
        canvasRevision: 9,
        label: "Tweak hero",
      },
    });
    expect(draft.annotation.text).toContain("checkpoint entry-7 (canvas revision 9)");
    expect(draft.annotation.text).toContain("list_history");
    const json = referenceJson(draft.annotation.text) as { frames: Array<Record<string, unknown>> };
    expect(json.frames[0]).not.toHaveProperty("frameRevision");
  });

  test("keeps the whole handoff within the byte budget", () => {
    const draft = buildDesignHandoffDraft({
      id: "h1",
      canvasId: "canvas-1",
      canvasName: "n".repeat(10_000),
      environmentId: "env-1",
      frames: frames.map((frame) => ({ ...frame, name: "界".repeat(2_000) })),
      revision: { kind: "current", canvasRevision: 1 },
      brief: "界".repeat(50_000),
    });
    expect(draft.bytes).toBeLessThanOrEqual(DESIGN_HANDOFF_MAX_BYTES);
    expect(isTranscriptAnnotation(draft.annotation)).toBe(true);
  });
});

describe("composer draft planning", () => {
  const annotation = buildDesignContextAnnotation({ id: "a1", reference });

  test("adds an annotation and a request to an empty composer", () => {
    const plan = planDesignDraft(
      { text: "", annotations: [] },
      { annotation, requestText: "Look at this" },
      { inlineText: false },
    );
    expect(plan).toEqual({
      ok: true,
      duplicate: false,
      patch: { annotations: [annotation], text: "Look at this" },
    });
  });

  test("never overwrites unsent text or existing annotations", () => {
    const existing: TranscriptAnnotation = { id: "t1", text: "quoted", comment: "" };
    const plan = planDesignDraft(
      { text: "my unsent words", annotations: [existing] },
      { annotation, requestText: "Look at this" },
      { inlineText: false },
    );
    expect(plan).toEqual({
      ok: true,
      duplicate: false,
      patch: { annotations: [existing, annotation] },
    });

    const handoff = planDesignDraft(
      { text: "my unsent words", annotations: [] },
      { annotation, appendText: "Handoff text" },
      { inlineText: false },
    );
    expect(handoff.ok && handoff.patch.text).toBe("my unsent words\n\nHandoff text");
  });

  test("does not stack identical context twice", () => {
    const plan = planDesignDraft(
      { text: "", annotations: [annotation] },
      { annotation: { ...annotation, id: "a2" } },
      { inlineText: false },
    );
    expect(plan).toEqual({ ok: true, duplicate: true, patch: {} });
  });

  test("reports a full annotation list instead of dropping context", () => {
    const full = Array.from({ length: MAX_TRANSCRIPT_ANNOTATIONS }, (_, index) => ({
      id: `t${index}`,
      text: `t${index}`,
      comment: "",
    }));
    expect(
      planDesignDraft({ text: "", annotations: full }, { annotation }, { inlineText: false }),
    ).toEqual({
      ok: false,
      reason: "annotation-limit",
    });
  });

  test("writes the inert context block as visible text for an unassigned composer", () => {
    const plan = planDesignDraft(
      { text: "keep me", annotations: [] },
      { annotation, requestText: "ignored" },
      { inlineText: true },
    );
    const block = buildPromptWithTranscriptAnnotations("", [annotation]);
    expect(plan).toEqual({ ok: true, duplicate: false, patch: { text: `keep me\n\n${block}` } });
  });
});

describe("linked conversation ordering", () => {
  test("lists design links before implementation links, newest first", () => {
    const link = (
      id: string,
      role: DesignSessionLink["role"],
      createdAt: string,
    ): DesignSessionLink => ({
      id,
      tabId: `tab-${id}`,
      platform: "claude",
      role,
      createdAt,
    });
    const ordered = orderDesignSessionLinks([
      link("impl", "implementation", "2026-09-24T03:00:00Z"),
      link("old", "design", "2026-09-24T01:00:00Z"),
      link("new", "design", "2026-09-24T02:00:00Z"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["new", "old", "impl"]);
  });
});
