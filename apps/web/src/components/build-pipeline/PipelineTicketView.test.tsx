import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useKanbanStore } from "@/stores/kanbanStore";
import { build } from "./pipeline-test-fixture";
import { PipelineTicketView, ticketChangedSinceStart, ticketImageUrl } from "./PipelineTicketView";

const snapshot = {
  title: "Original ticket",
  description: "Stored description",
  acceptanceCriteria: "Stored criteria",
  comments: [{ text: "Stored comment" }],
  images: [
    {
      filename: "reference.bmp",
      data: "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
    },
    {
      filename: "reference.svg",
      data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    },
  ],
};

afterEach(() => {
  cleanup();
  useKanbanStore.setState({ tasks: [] });
});

describe("pipeline ticket references", () => {
  test.each(["bmp", "svg", "png", "jpg", "webp"])(
    "preserves the stored %s image with an explicit MIME type",
    (extension) => {
      const url = ticketImageUrl({ filename: `reference.${extension}`, data: " YQ==\n" });
      expect(url).toBe(
        `data:image/${extension === "svg" ? "svg+xml" : extension === "jpg" ? "jpeg" : extension};base64,YQ==`,
      );
    },
  );

  test("extensionless clipboard images use the WebP fallback", () => {
    expect(ticketImageUrl({ filename: "clipboard", data: " YQ==\n" })).toBe(
      "data:image/webp;base64,YQ==",
    );
  });

  test("rejects non-base64 content and unknown extensions", () => {
    expect(ticketImageUrl({ filename: "bad.svg", data: "<svg onload=alert(1)>" })).toBeNull();
    expect(ticketImageUrl({ filename: "bad.html", data: "YQ==" })).toBeNull();
  });

  test("shows both BMP and SVG snapshot references and opens their previews", () => {
    render(<PipelineTicketView pipeline={build({ taskSnapshot: snapshot })} />);
    const images = screen.getByRole("region", { name: "Reference images (2)" });
    expect(
      within(images)
        .getAllByRole("img")
        .map((image) => image.getAttribute("alt")),
    ).toEqual(["reference.bmp", "reference.svg"]);
    fireEvent.click(within(images).getByRole("button", { name: "Show image reference.svg" }));
    const preview = screen.getByRole("dialog");
    expect(within(preview).getByRole("img").getAttribute("src")).toBe(
      ticketImageUrl(snapshot.images[1]!),
    );
    fireEvent.click(within(preview).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog") === null).toBe(true);
    fireEvent.click(within(images).getByRole("button", { name: "Show image reference.bmp" }));
    expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe(
      ticketImageUrl(snapshot.images[0]!),
    );
  });

  test("shows edits to the live ticket while retaining the started-with snapshot", () => {
    useKanbanStore.setState({
      tasks: [
        {
          id: "task-1",
          title: "Edited ticket",
          description: "Live description",
          acceptanceCriteria: "Live criteria",
        },
      ] as never,
    });
    render(<PipelineTicketView pipeline={build({ taskSnapshot: snapshot })} />);
    expect(screen.getByTestId("pipeline-ticket-changed").textContent).toContain("has been edited");
    expect(screen.getByRole("heading", { name: "Original ticket" }).textContent).toBe(
      "Original ticket",
    );
    expect(screen.queryByText("Live description") === null).toBe(true);
    expect(ticketChangedSinceStart(snapshot, undefined)).toBe(false);
    expect(ticketChangedSinceStart(snapshot, { ...snapshot, title: " Original ticket " })).toBe(
      false,
    );
  });

  test("an older record without snapshot content explains the missing ticket", () => {
    render(
      <PipelineTicketView
        pipeline={build({ taskSnapshot: { ...snapshot, title: "", description: "" } })}
      />,
    );
    expect(screen.getByTestId("pipeline-ticket-placeholder").textContent).toContain(
      "did not store the ticket",
    );
  });
});
