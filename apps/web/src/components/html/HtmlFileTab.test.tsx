import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fileDirtyStore } from "@/stores/fileDirtyStore";
import * as realMonacoFileEditor from "@/components/terminal/MonacoFileEditor";
import { appCommandStore } from "@/test/app-command-store";

const realMonacoFileEditorSnapshot = { ...realMonacoFileEditor };

mock.module("@/components/terminal/MonacoFileEditor", () => ({
  MonacoFileEditor: ({
    language,
    value,
    onChange,
    onSave,
  }: {
    language: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
  }) => (
    <textarea
      aria-label={`Monaco ${language}`}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "s") onSave();
      }}
    />
  ),
}));

const { HtmlFileTab } = await import("./HtmlFileTab");

const TAB_ID = "html-tab";
const HTML = "<!doctype html><title>Report</title><h1>Original</h1>";
const onSave = mock(async () => true);

function renderTab(props: { lineNumber?: number; navigationRequestId?: number } = {}) {
  return (
    <HtmlFileTab
      tabId={TAB_ID}
      filePath="docs/report.html"
      initialContent={HTML}
      language="html"
      isActive
      isSaving={false}
      onSave={onSave}
      {...props}
    />
  );
}

function frame(): HTMLIFrameElement {
  return screen.getByTitle("Rendered view of docs/report.html") as HTMLIFrameElement;
}

function selectMode(name: "Rendered" | "Raw"): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
}

beforeEach(() => {
  appCommandStore(fileDirtyStore).setState({ dirtyFiles: new Map() });
  appCommandStore(fileDirtyStore).getState().setOriginalContent(TAB_ID, HTML);
  onSave.mockClear();
});

afterEach(() => {
  cleanup();
  appCommandStore(fileDirtyStore).setState({ dirtyFiles: new Map() });
});

afterAll(() => {
  mock.module("@/components/terminal/MonacoFileEditor", () => realMonacoFileEditorSnapshot);
});

describe("HtmlFileTab", () => {
  test("opens on the rendered page in an iframe with no sandbox grants", () => {
    render(renderTab());

    expect(screen.getByRole("tab", { name: "Rendered" }).getAttribute("data-state")).toBe("active");
    expect(screen.getByText("docs/report.html")).toBeTruthy();
    expect(frame().getAttribute("sandbox")).toBe("");
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame().getAttribute("srcdoc")).toContain("<h1>Original</h1>");
    expect(frame().getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(screen.queryByRole("textbox") === null).toBe(true);
  });

  test("Raw shows the source, and raw edits reach the store and the rendered page", async () => {
    render(renderTab());

    selectMode("Raw");
    const editor = await screen.findByRole("textbox", { name: "Monaco html" });
    expect((editor as HTMLTextAreaElement).value).toBe(HTML);
    expect(screen.queryByTitle("Rendered view of docs/report.html") === null).toBe(true);

    fireEvent.change(editor, { target: { value: "<h1>Edited</h1>" } });
    expect(appCommandStore(fileDirtyStore).getState().getContent(TAB_ID)).toBe("<h1>Edited</h1>");

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);

    selectMode("Rendered");
    expect(frame().getAttribute("srcdoc")).toContain("<h1>Edited</h1>");
    // The file's own text is what is saved: the preview's additions stay out of it.
    expect(appCommandStore(fileDirtyStore).getState().getContent(TAB_ID)).toBe("<h1>Edited</h1>");
  });

  test.each(["ctrlKey", "metaKey"])("saves from Rendered using %s", async (modifier) => {
    render(renderTab());
    selectMode("Raw");
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "<p>Dirty</p>" } });
    selectMode("Rendered");
    fireEvent.keyDown(window, { key: "s", [modifier]: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test("restores an unsaved buffer instead of the disk content", () => {
    appCommandStore(fileDirtyStore).getState().setContent(TAB_ID, "<h1>Unsaved</h1>");
    render(renderTab());

    expect(frame().getAttribute("srcdoc")).toContain("<h1>Unsaved</h1>");
  });

  test("opens on Raw when asked for a line", async () => {
    render(renderTab({ lineNumber: 12, navigationRequestId: 1 }));

    expect(screen.getByRole("tab", { name: "Raw" }).getAttribute("data-state")).toBe("active");
    expect(await screen.findByRole("textbox", { name: "Monaco html" })).toBeTruthy();
  });

  test("switches to Raw when a later navigation names a line", async () => {
    const view = render(renderTab());
    expect(screen.getByRole("tab", { name: "Rendered" }).getAttribute("data-state")).toBe("active");

    view.rerender(renderTab({ lineNumber: 3, navigationRequestId: 1 }));

    expect(screen.getByRole("tab", { name: "Raw" }).getAttribute("data-state")).toBe("active");
    expect(await screen.findByRole("textbox", { name: "Monaco html" })).toBeTruthy();
  });

  test("explains a page whose scripts or external files are refused, in Rendered only", async () => {
    appCommandStore(fileDirtyStore)
      .getState()
      .setContent(TAB_ID, "<script>draw()</script><h1>Chart</h1>");
    render(renderTab());
    const notice = /does not run scripts or load external files/;

    expect(screen.getByText(notice)).toBeTruthy();

    selectMode("Raw");
    await screen.findByRole("textbox", { name: "Monaco html" });
    expect(screen.queryByText(notice) === null).toBe(true);
  });

  test("the panel divider can be dragged across the iframe", async () => {
    // The frame would otherwise take the drag's pointer events and end it.
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text();
    expect(css).toContain(
      'body:has([data-slot="resizable-handle"][data-separator="active"]) iframe',
    );
  });

  test("shows no notice for a self-contained page", () => {
    render(renderTab());

    expect(screen.queryByText(/does not run scripts/) === null).toBe(true);
  });
});
