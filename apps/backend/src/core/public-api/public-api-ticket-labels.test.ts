import { afterEach, describe, expect, test } from "bun:test";
import type {
  PublicPage,
  PublicTicketDetail,
  PublicTicketLabel,
  PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * Ticket labels as public actions, through the real registry and storage:
 * the catalogue, adding and removing one label, and labels on create,
 * update, list and get.
 */

afterEach(cleanupSessionHarnesses);

describe("ticket label actions", () => {
  test("create a label, add it to an existing ticket, list and filter by it", async () => {
    const { harness, projectId } = await setup();
    const created = await harness.call<{ projectId: string; name: string; created: boolean }>(
      "ticket.label.create",
      { projectId, name: "Needs  design", color: "#A855F7", description: "Waiting on a mock" },
      { requestId: "label-1" },
    );
    if (!created.ok) throw new Error(created.error.message);
    expect(created.result).toEqual({ projectId, name: "Needs design", created: true });
    const again = await harness.call<{ created: boolean }>(
      "ticket.label.create",
      { projectId, name: "needs design" },
      { requestId: "label-2" },
    );
    expect(again.ok && again.result.created).toBe(false);

    const ticket = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Settings page" },
      { requestId: "ticket-1" },
    );
    if (!ticket.ok) throw new Error(ticket.error.message);
    const ticketId = ticket.result.ticketId;
    const other = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Login bug", labels: ["bug"] },
      { requestId: "ticket-2" },
    );
    if (!other.ok) throw new Error(other.error.message);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const labelled = await harness.call<{ labels: string[] }>(
        "ticket.label",
        { projectId, ticketId, name: "NEEDS DESIGN" },
        { requestId: "add-1" },
      );
      if (!labelled.ok) throw new Error(labelled.error.message);
      expect(labelled.result.labels).toEqual(["Needs design"]);
    }
    const bug = await harness.call<{ labels: string[] }>(
      "ticket.label",
      { projectId, ticketId, name: "Bug" },
      { requestId: "add-2" },
    );
    expect(bug.ok && bug.result.labels).toEqual(["Needs design", "bug"]);

    const labels = await harness.call<{ labels: PublicTicketLabel[]; total: number }>(
      "ticket.labels",
      { projectId },
    );
    if (!labels.ok) throw new Error(labels.error.message);
    expect(labels.result).toMatchObject({
      total: 2,
      labels: [
        {
          name: "Needs design",
          color: "#a855f7",
          description: "Waiting on a mock",
          ticketCount: 1,
        },
        { name: "bug", ticketCount: 2 },
      ],
    });

    const detail = await harness.call<PublicTicketDetail>("ticket.get", { projectId, ticketId });
    expect(detail.ok && detail.result.labels).toEqual(["Needs design", "bug"]);
    const filtered = await harness.call<PublicPage<PublicTicketSummary>>("ticket.list", {
      projectId,
      label: "needs design",
    });
    expect(filtered.ok && filtered.result.items.map((item) => item.id)).toEqual([ticketId]);
    const all = await harness.call<PublicPage<PublicTicketSummary>>("ticket.list", { projectId });
    expect(all.ok && all.result.items.map((item) => item.labels)).toEqual([
      ["Needs design", "bug"],
      ["bug"],
    ]);

    const removed = await harness.call<{ labels: string[] }>(
      "ticket.label",
      { projectId, ticketId, name: "needs design", present: false },
      { requestId: "remove-1" },
    );
    expect(removed.ok && removed.result.labels).toEqual(["bug"]);
  });

  test("ticket.update preserves uncatalogued spelling on the sole labelled ticket", async () => {
    const { harness, projectId } = await setup();
    const created = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Bug", labels: ["bug"] },
      { requestId: "create" },
    );
    if (!created.ok) throw new Error(created.error.message);
    const ticketId = created.result.ticketId;
    expect(
      (
        await harness.call(
          "ticket.update",
          { projectId, ticketId, labels: ["BUG", "ui"] },
          { requestId: "update" },
        )
      ).ok,
    ).toBe(true);
    const detail = await harness.call<PublicTicketDetail>("ticket.get", { projectId, ticketId });
    expect(detail.ok && detail.result.labels).toEqual(["bug", "ui"]);
  });

  test.each(["", "  \t "])(
    "ticket.label.create clears a supplied empty description %j",
    async (description) => {
      const { harness, projectId } = await setup();
      expect(
        (
          await harness.call(
            "ticket.label.create",
            { projectId, name: "Bug", description: "Old" },
            { requestId: "create" },
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await harness.call(
            "ticket.label.create",
            { projectId, name: "bug" },
            { requestId: "omit" },
          )
        ).ok,
      ).toBe(true);
      const retained = await harness.call<{ labels: PublicTicketLabel[] }>("ticket.labels", {
        projectId,
      });
      expect(retained.ok && retained.result.labels[0]?.description).toBe("Old");
      expect(
        (
          await harness.call(
            "ticket.label.create",
            { projectId, name: "BUG", description },
            { requestId: "clear" },
          )
        ).ok,
      ).toBe(true);
      const cleared = await harness.call<{ labels: PublicTicketLabel[] }>("ticket.labels", {
        projectId,
      });
      expect(cleared.ok && cleared.result.labels[0]?.description).toBeUndefined();
    },
  );

  test("update replaces or clears labels; invalid labels are refused before admission", async () => {
    const { harness, projectId } = await setup();
    const ticket = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Docs", labels: ["docs", "Docs", "ui"] },
      { requestId: "ticket-1" },
    );
    if (!ticket.ok) throw new Error(ticket.error.message);
    const ticketId = ticket.result.ticketId;
    const read = async () => {
      const detail = await harness.call<PublicTicketDetail>("ticket.get", { projectId, ticketId });
      if (!detail.ok) throw new Error(detail.error.message);
      return detail.result.labels;
    };
    expect(await read()).toEqual(["docs", "ui"]);

    const replaced = await harness.call(
      "ticket.update",
      { projectId, ticketId, labels: ["release"] },
      { requestId: "update-1" },
    );
    expect(replaced.ok).toBe(true);
    expect(await read()).toEqual(["release"]);
    const cleared = await harness.call(
      "ticket.update",
      { projectId, ticketId, labels: [] },
      { requestId: "update-2" },
    );
    expect(cleared.ok).toBe(true);
    expect(await read()).toEqual([]);

    const blank = await harness.call(
      "ticket.label",
      { projectId, ticketId, name: "   " },
      { requestId: "bad-1" },
    );
    expect(!blank.ok && blank.error.code).toBe("invalid-input");
    const tooMany = await harness.call(
      "ticket.update",
      { projectId, ticketId, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      { requestId: "bad-2" },
    );
    expect(!tooMany.ok && tooMany.error.code).toBe("invalid-input");
    const badColor = await harness.call(
      "ticket.label.create",
      { projectId, name: "x", color: "red" },
      { requestId: "bad-3" },
    );
    expect(!badColor.ok && badColor.error.code).toBe("invalid-input");
    const missing = await harness.call(
      "ticket.label",
      { projectId, ticketId: "missing", name: "bug" },
      { requestId: "bad-4" },
    );
    expect(!missing.ok && missing.error.code).toBe("not-found");
  });
});
