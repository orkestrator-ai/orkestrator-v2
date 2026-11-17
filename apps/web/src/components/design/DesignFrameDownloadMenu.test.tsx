import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesignFrameDownloadMenu } from "./DesignFrameDownloadMenu";

function open(name = "Download Home") {
  const trigger = screen.getByRole("button", { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

describe("DesignFrameDownloadMenu", () => {
  afterEach(cleanup);

  test("one selected frame offers PNG, WEBP and PDF, plus every frame on the canvas", async () => {
    const onDownload = mock(() => Promise.resolve());
    render(
      <DesignFrameDownloadMenu
        frameName="Home"
        selectedCount={1}
        frameCount={3}
        onDownload={onDownload}
      />,
    );
    const menu = await open();
    const groups = within(menu).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "This frame",
      "All frames (3)",
    ]);
    expect(
      within(groups[0]!)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["PNG image", "WEBP image", "PDF document"]);
    expect(
      within(groups[1]!)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["PDF (one page per frame)", "PNG images (.zip)", "WEBP images (.zip)"]);
    expect(within(menu).queryByRole("group", { name: /Selected frames/ }) === null).toBe(true);

    await act(async () => {
      fireEvent.click(within(groups[0]!).getByRole("menuitem", { name: "WEBP image" }));
    });
    expect(onDownload).toHaveBeenCalledWith("frame", "webp");
  });

  test("several selected frames add a separated group for the selection", async () => {
    const onDownload = mock(() => Promise.resolve());
    render(
      <DesignFrameDownloadMenu
        frameName="Home"
        selectedCount={2}
        frameCount={4}
        onDownload={onDownload}
      />,
    );
    const menu = await open();
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["This frame", "Selected frames (2)", "All frames (4)"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    const selected = within(menu).getByRole("group", { name: "Selected frames (2)" });
    await act(async () => {
      fireEvent.click(within(selected).getByRole("menuitem", { name: "PNG images (.zip)" }));
    });
    expect(onDownload).toHaveBeenCalledWith("selected", "png");
  });

  test("a canvas with one frame has no all-frames group", async () => {
    render(
      <DesignFrameDownloadMenu
        frameName="Home"
        selectedCount={1}
        frameCount={1}
        onDownload={() => Promise.resolve()}
      />,
    );
    const menu = await open();
    expect(within(menu).getAllByRole("group")).toHaveLength(1);
    expect(within(menu).queryByRole("separator") === null).toBe(true);
  });

  test("the button shows progress and is disabled until the download settles", async () => {
    let finish!: () => void;
    const onDownload = mock(() => new Promise<void>((resolve) => (finish = resolve)));
    render(
      <DesignFrameDownloadMenu
        frameName="Home"
        selectedCount={1}
        frameCount={2}
        onDownload={onDownload}
      />,
    );
    const menu = await open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "PDF document" }));
    const trigger = screen.getByRole("button", { name: "Download Home" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(true));
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  });
});
