import { describe, expect, test } from "bun:test";
import { parseTicketSyncItem, parseTicketSyncOp } from "./ticket-sync.js";

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
