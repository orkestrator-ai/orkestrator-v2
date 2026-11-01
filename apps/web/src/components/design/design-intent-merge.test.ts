import { describe, expect, test } from "bun:test";
import {
  DESIGN_INTENT_LIMITS,
  type DesignStoredIntent,
} from "@orkestrator/protocol/design-operations";
import type { DesignIntent } from "@/stores/designStore";
import { fromStoredIntent, mergeIntents, toIntentDraft } from "./design-intent-merge";

const NOW = 1_000_000;
const ME = "c-me";
const OTHER = "c-other";

function stored(id: string, extra: Partial<DesignStoredIntent> = {}): DesignStoredIntent {
  return {
    id,
    clientId: ME,
    lane: "frame",
    label: `Edit ${id}`,
    createdAt: 1,
    updatedAt: NOW - 60_000,
    descriptor: {
      canvasId: "canvas",
      input: { kind: "update_frame", frameId: "frame", patch: { x: 1 } },
      preconditions: { frameRevision: 1 },
      clientId: extra.clientId ?? ME,
      correlationId: id,
    },
    phase: "draft",
    ...extra,
  };
}

const local = (
  id: string,
  extra: Partial<DesignStoredIntent> = {},
  view: Partial<DesignIntent> = {},
) => ({
  ...fromStoredIntent(stored(id, extra), "env", "canvas"),
  ...view,
});

function merge(
  intents: DesignIntent[],
  server: DesignStoredIntent[],
  options: {
    running?: string[];
    unsaved?: string[];
    discarded?: string[];
    sending?: string[];
  } = {},
) {
  return mergeIntents(
    intents,
    { intents: server, sending: options.sending ?? [], now: NOW },
    {
      environmentId: "env",
      canvasId: "canvas",
      clientId: ME,
      running: new Set(options.running),
      unsaved: new Set(options.unsaved),
      discarded: new Set(options.discarded),
    },
  );
}

describe("merging the backend's intent queue", () => {
  test("intents this window does not hold are restored: they never run without Resume", () => {
    const { intents } = merge(
      [],
      [
        stored("mine"),
        stored("failed", { clientId: OTHER, phase: "settled", outcome: "rejected" }),
      ],
    );
    expect(intents.map((intent) => [intent.id, intent.restored])).toEqual([
      ["mine", true],
      ["failed", true],
    ]);
  });

  test("another window's edit in flight is not this window's to review", () => {
    const recent = NOW - DESIGN_INTENT_LIMITS.foreignDraftQuietMs + 1;
    const { intents } = merge(
      [],
      [
        stored("preparing", { clientId: OTHER, phase: "preparing" }),
        stored("sending", { clientId: OTHER, phase: "admitted", token: "t" }),
        stored("queued", { clientId: OTHER, updatedAt: recent }),
        stored("abandoned", { clientId: OTHER }),
      ],
      { sending: ["sending"] },
    );
    expect(intents.map((intent) => intent.id)).toEqual(["abandoned"]);
  });

  test("a listed edit its window picks up again leaves the review list quietly", () => {
    const shown = local("edit", { clientId: OTHER }, { restored: true });
    const result = merge([shown], [stored("edit", { clientId: OTHER, phase: "preparing" })]);
    expect(result.intents).toEqual([]);
    expect(result.savedElsewhere).toEqual([]);
  });

  test("only an edit shown as unresolved is announced as saved", () => {
    const unresolved = local(
      "unresolved",
      { phase: "admitted", outcome: "unknown", token: "t" },
      { restored: true },
    );
    const draft = local("draft", {}, { restored: true });
    const success = { phase: "settled" as const, outcome: "committed" as const, token: "t" };
    const result = merge(
      [unresolved, draft],
      [stored("unresolved", success), stored("draft", success)],
    );
    expect(result.savedElsewhere).toEqual(["Edit unresolved"]);
  });

  test("a recently committed edit this window never held stays out", () => {
    const { intents } = merge(
      [],
      [stored("done", { phase: "settled", outcome: "committed", token: "t" })],
    );
    expect(intents).toEqual([]);
  });

  test("a run with no answer is settled by the queue: unrecorded edits are sent again", () => {
    const uncertain = (id: string) => local(id, { phase: "admitted", outcome: "unknown" }, {});
    const success = { phase: "settled" as const, outcome: "committed" as const, token: "t" };
    const result = merge(
      [uncertain("never-arrived"), uncertain("saved-draft"), uncertain("ran")],
      [stored("saved-draft"), stored("ran", success)],
    );
    expect(result.retry.sort()).toEqual(["never-arrived", "saved-draft"]);
    expect(result.intents.map((intent) => [intent.id, intent.phase])).toEqual([
      ["never-arrived", "draft"],
      ["saved-draft", "draft"],
      ["ran", "settled"],
    ]);
  });

  test("a failure learned from the queue pauses dependent edits, as a run's answer does", () => {
    const uncertain = local("lost", { phase: "admitted", outcome: "unknown", createdAt: 5 });
    const later = local("later", { createdAt: 6 });
    const earlier = local("earlier", { createdAt: 4 });
    const otherLane = local("other", { createdAt: 7, lane: "frame-2" });
    const failure = {
      code: "conflict" as const,
      message: "Stale",
      retry: "after-refresh" as const,
    };
    const result = merge(
      [uncertain, earlier, later, otherLane],
      [
        stored("lost", { phase: "settled", outcome: "rejected", failure, createdAt: 5 }),
        stored("earlier", { createdAt: 4 }),
        stored("later", { createdAt: 6 }),
        stored("other", { createdAt: 7, lane: "frame-2" }),
      ],
    );
    expect(result.failed.map((intent) => intent.id)).toEqual(["lost"]);
    expect(result.intents.map((intent) => [intent.id, intent.blocked ?? false])).toEqual([
      ["lost", false],
      ["earlier", false],
      ["later", true],
      ["other", false],
    ]);
  });

  test("what this window is sending or has not saved is not overwritten", () => {
    const running = local("running", {}, { phase: "preparing" });
    const unsaved = local("unsaved");
    const sample = local("sample", {}, { label: "Newer sample" });
    const result = merge(
      [running, unsaved, sample],
      [stored("running", { phase: "preparing" }), stored("sample")],
      { running: ["running"], unsaved: ["unsaved"] },
    );
    expect(result.intents).toEqual([running, unsaved, sample]);
    expect(result.changed).toBe(false);
  });

  test("a saved draft the backend no longer holds was discarded elsewhere", () => {
    expect(merge([local("gone")], []).intents).toEqual([]);
  });

  test("a discarded intent's stale server copy does not come back", () => {
    expect(merge([], [stored("gone")], { discarded: ["gone"] }).intents).toEqual([]);
  });

  test("another window resuming an edit takes it away from this one", () => {
    const mine = local("edit");
    const { intents } = merge([mine], [stored("edit", { clientId: OTHER })], {});
    expect(intents[0]).toMatchObject({ id: "edit", restored: true });
  });

  test("a prepared token never sent shows as prepared, so it can be resumed or canceled", () => {
    expect(
      fromStoredIntent(stored("t", { phase: "admitted", token: "t" }), "env", "canvas").phase,
    ).toBe("prepared");
    expect(
      fromStoredIntent(
        stored("t", { phase: "admitted", outcome: "executing", token: "t" }),
        "env",
        "canvas",
      ).phase,
    ).toBe("admitted");
  });

  test("the draft sent to the backend carries only what it stores", () => {
    const draft = toIntentDraft({
      ...local("edit"),
      label: "x".repeat(500),
      preview: { frameId: "frame", patch: { x: 1 } },
      blocked: true,
      restored: true,
      awaitRevision: 3,
    });
    expect(Object.keys(draft).sort()).toEqual([
      "createdAt",
      "descriptor",
      "id",
      "label",
      "lane",
      "preview",
    ]);
    expect(draft.label).toHaveLength(200);
  });
});
