import { describe, expect, test } from "bun:test";
import { parseTicketSyncItem, parseTicketSyncOp, TICKET_SYNC_LIMITS } from "./ticket-sync.js";

const prMergeDoneUrl = "https://github.com/acme/repo/pull/1";
const ticket = {
  title: "Ticket",
  status: "done",
  comments: [],
  createdAt: "2026-11-07T00:00:00Z",
  description: "",
  acceptanceCriteria: "",
};
const snapshot = { ...ticket, id: "ticket-1", seq: 1, revs: { status: 1 } };

describe("merge identity travels with status", () => {
  test("preserves the marker in snapshots, creation and status operations", () => {
    expect(parseTicketSyncItem({ ...snapshot, prMergeDoneUrl })).toMatchObject({
      status: "done",
      prMergeDoneUrl,
    });
    expect(
      parseTicketSyncOp({ kind: "create", ticket: { ...ticket, prMergeDoneUrl } }),
    ).toMatchObject({ ticket: { prMergeDoneUrl } });
    // User reopening retains the identity of the merge already applied.
    expect(
      parseTicketSyncOp({ kind: "set-status", value: "review", baseRev: 1, prMergeDoneUrl }),
    ).toEqual({ kind: "set-status", value: "review", baseRev: 1, prMergeDoneUrl });
  });

  test("accepts older peers that omit the optional marker", () => {
    expect(parseTicketSyncItem(snapshot)).not.toHaveProperty("prMergeDoneUrl");
    expect(parseTicketSyncOp({ kind: "create", ticket })).not.toHaveProperty(
      "ticket.prMergeDoneUrl",
    );
    expect(parseTicketSyncOp({ kind: "set-status", value: "done", baseRev: 0 })).toEqual({
      kind: "set-status",
      value: "done",
      baseRev: 0,
    });
  });

  for (const marker of [null, 5, "", "x".repeat(4001)]) {
    test(`rejects an invalid merge marker (${typeof marker}, ${String(marker).length} characters)`, () => {
      expect(() => parseTicketSyncItem({ ...snapshot, prMergeDoneUrl: marker })).toThrow(
        "Invalid ticket merge closure URL",
      );
      expect(() =>
        parseTicketSyncOp({ kind: "create", ticket: { ...ticket, prMergeDoneUrl: marker } }),
      ).toThrow("Invalid ticket merge closure URL");
      expect(() =>
        parseTicketSyncOp({
          kind: "set-status",
          value: "done",
          baseRev: 0,
          prMergeDoneUrl: marker,
        }),
      ).toThrow("Invalid ticket merge closure URL");
    });
  }
});

describe("image references (#2027)", () => {
  const image = {
    id: "0f5c2a52-1d1e-4a0b-9d8a-3b8f0c7d6e5f",
    filename: "screen.png",
    createdAt: "2026-11-09T00:00:00.000Z",
    nodeId: "bk_command",
  };

  test("travel on snapshots, creations and their own operations", () => {
    expect(parseTicketSyncItem({ ...snapshot, images: [image] })).toMatchObject({
      images: [image],
    });
    expect(parseTicketSyncOp({ kind: "create", ticket: { ...ticket, images: [image] } })).toEqual(
      expect.objectContaining({ ticket: expect.objectContaining({ images: [image] }) }),
    );
    expect(parseTicketSyncOp({ kind: "add-image", image })).toEqual({ kind: "add-image", image });
    expect(parseTicketSyncOp({ kind: "delete-image", imageId: image.id })).toEqual({
      kind: "delete-image",
      imageId: image.id,
    });
  });

  test("are absent from an older peer's snapshot, so the receiver keeps its own", () => {
    expect(parseTicketSyncItem(snapshot)).not.toHaveProperty("images");
  });

  for (const bad of [
    { ...image, id: "../escape" },
    { ...image, filename: 5 },
    { ...image, nodeId: "" },
  ]) {
    test(`refuses an unreadable image (${JSON.stringify(bad).slice(0, 40)})`, () => {
      expect(() => parseTicketSyncItem({ ...snapshot, images: [bad] })).toThrow(
        "Invalid ticket image",
      );
      expect(() => parseTicketSyncOp({ kind: "add-image", image: bad })).toThrow(
        "Invalid ticket image",
      );
    });
  }

  test("refuses more references than one ticket may carry", () => {
    const many = Array.from({ length: TICKET_SYNC_LIMITS.maxImageRefs + 1 }, (_, index) => ({
      ...image,
      id: `image-${index}`,
    }));
    expect(() => parseTicketSyncItem({ ...snapshot, images: many })).toThrow(
      "Invalid ticket images",
    );
  });
});
