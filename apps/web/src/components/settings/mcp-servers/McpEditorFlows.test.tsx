import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { mcpFailure } from "@orkestrator/protocol/mcp-management";

import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import {
  SECRET,
  TRANSPORT_FAILURE,
  baseHandlers,
  callsOf,
  environmentTarget,
  install,
  preview,
  resetInvoke,
  snapshot,
  target,
} from "./mcp-test-fixtures";
import { ProviderMcpSettings } from "./ProviderMcpSettings";

afterEach(() => {
  cleanup();
  resetInvoke();
});

async function openAdd() {
  fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
}

function alertsText(): string {
  return screen
    .queryAllByRole("alert")
    .map((alert) => alert.textContent ?? "")
    .join("\n");
}

describe("MCP editor: preview intent", () => {
  test("the shared preview is requested with save-and-apply, so the stdio warning shows", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: (args) => ({
        valid: true,
        fieldErrors: [],
        preview: {
          ...preview,
          warnings:
            (args.mutation as { applyIntent: string }).applyIntent === "save-and-apply"
              ? ["Applying starts this server's command on this backend."]
              : [],
        },
      }),
      mutate_mcp_definition: () => ({
        operation: {},
        replayed: false,
        savedRevision: "r1.two",
        entryId: "x",
      }),
    });
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByText(/Applying starts this server's command/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(1));
    const [validated] = callsOf("validate_mcp_mutation");
    const [saved] = callsOf("mutate_mcp_definition");
    expect(validated!.mutation.applyIntent).toBe("save-and-apply");
    // Save still saves only; the preview id is never reused for the write.
    expect(saved!.mutation.applyIntent).toBe("save");
    expect(saved!.mutation.requestId).not.toBe(validated!.mutation.requestId);
    expect(saved!.mutation.operation.expectedRevision).toBe("r1.one");
  });

  test("remove previews with save-and-apply too", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    await screen.findByLabelText("Change preview");
    expect(callsOf("validate_mcp_mutation")[0]!.mutation.applyIntent).toBe("save-and-apply");
  });
});

describe("MCP editor: local validation", () => {
  test("shows field errors inline before any backend request, and clears them as fixed", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
    });
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bad name!" } });
    fireEvent.click(screen.getByRole("button", { name: /Add variable/ }));
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), {
      target: { value: "1BAD" },
    });
    fireEvent.change(screen.getByLabelText("Environment variables value 1"), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));

    expect(await screen.findByText("Not a valid name for this platform.")).toBeTruthy();
    expect(screen.getByText(/Must not be empty/)).toBeTruthy(); // the executable
    expect(screen.getByText(/do not start with a digit/)).toBeTruthy();
    expect(callsOf("validate_mcp_mutation").length).toBe(0);
    // Error text names the problem, never the value.
    expect(alertsText()).not.toContain(SECRET);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    expectDomAbsent(screen.queryByText("Not a valid name for this platform."), "fixed name error");
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), {
      target: { value: "API_KEY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByLabelText("Change preview");
    expect(callsOf("validate_mcp_mutation").length).toBe(1);
  });

  test("a remote URL and unnamed header are checked locally", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
    });
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "remote" } });
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "ftp://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Add header/ }));
    fireEvent.change(screen.getByLabelText("Headers value 1"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByText("Must use http or https.")).toBeTruthy();
    expect(screen.getByText("Every header needs a name.")).toBeTruthy();
    expect(callsOf("validate_mcp_mutation").length).toBe(0);
    expect(alertsText()).not.toContain(SECRET);
  });
});

describe("MCP editor: error notices", () => {
  test("a transport error that echoes a typed secret is shown without it", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => {
        throw new Error(`${TRANSPORT_FAILURE}: proxy rejected API_KEY=${SECRET}`);
      },
    });
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.click(screen.getByRole("button", { name: /Add variable/ }));
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), {
      target: { value: "API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("Environment variables value 1"), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByText(/proxy rejected API_KEY=\[hidden\]/)).toBeTruthy();
    expect(alertsText()).not.toContain(SECRET);
  });

  test("a structured error shows its correlation id as a copyable reference", async () => {
    mockWriteText.mockClear();
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => {
        throw mcpFailure("internal", { correlationId: "corr-7f3a" });
      },
    });
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByLabelText("Change preview");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("corr-7f3a")).toBeTruthy();
    expect(alertsText()).toContain("Reference:");
    fireEvent.click(screen.getByRole("button", { name: "Copy error reference" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith("corr-7f3a"));
  });

  test("a snapshot read failure shows its reference too", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () => {
        throw mcpFailure("target-offline", { correlationId: "corr-snap" });
      },
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText("corr-snap")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("MCP editor: switching target with a draft", () => {
  function installTwoContexts() {
    install({
      list_mcp_management_targets: (args) => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: args.environmentId ? [target, environmentTarget("e1")] : [target],
      }),
      get_mcp_management_snapshot: (args) =>
        String(args.targetId).includes("~env~")
          ? snapshot({
              target: environmentTarget("e1"),
              definitions: [{ ...snapshot().definitions[0]!, name: "docs-e1" }],
            })
          : snapshot(),
    });
  }

  test("asks before discarding, and keeping leaves the draft and target alone", async () => {
    installTwoContexts();
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "half-typed" } });

    act(() => requestMcpServerSettings({ provider: "pi", environmentId: "e1" }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expectDomAbsent(screen.queryByText("Discard unsaved changes?"), "discard prompt"),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("half-typed");
    expect(
      callsOf("get_mcp_management_snapshot").every((call) => call.targetId === target.targetId),
    ).toBe(true);

    act(() => requestMcpServerSettings({ provider: "pi", environmentId: "e1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and switch" }));
    expect(await screen.findByText("docs-e1")).toBeTruthy();
    expectDomAbsent(screen.queryByLabelText("Name"), "discarded editor");
  });

  test("an untouched editor switches without asking", async () => {
    installTwoContexts();
    render(<ProviderMcpSettings />);
    await openAdd();
    act(() => requestMcpServerSettings({ provider: "pi", environmentId: "e1" }));
    expect(await screen.findByText("docs-e1")).toBeTruthy();
    expectDomAbsent(screen.queryByText("Discard unsaved changes?"), "discard prompt");
  });
});

describe("MCP editor: closing with a draft", () => {
  test("Escape and Cancel ask before discarding; an untouched editor closes at once", async () => {
    install(baseHandlers);
    render(<ProviderMcpSettings />);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "half-typed" } });

    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expectDomAbsent(screen.queryByText("Discard unsaved changes?"), "discard prompt"),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("half-typed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and close" }));
    await waitFor(() => expectDomAbsent(screen.queryByLabelText("Name"), "closed editor"));
    expect(callsOf("mutate_mcp_definition")).toEqual([]);

    await openAdd();
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    await waitFor(() => expectDomAbsent(screen.queryByLabelText("Name"), "closed editor"));
    expectDomAbsent(screen.queryByText("Discard unsaved changes?"), "discard prompt");
  });
});

describe("MCP dialogs: layering above fullscreen settings", () => {
  // Settings is a fullscreen surface at z-[60]; a default z-50 dialog would
  // render behind it while Radix disables pointer events on the page.
  test("the editor, its select and the discard prompt use the fullscreen dialog layers", async () => {
    install(baseHandlers);
    render(<ProviderMcpSettings />);
    await openAdd();
    const editor = await screen.findByRole("dialog");
    expect(editor.className).toContain("z-[80]");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const prompt = await screen.findByRole("alertdialog");
    expect(prompt.className).toContain("z-[90]");
  });

  test("row action dialogs use the fullscreen dialog layer", async () => {
    install(baseHandlers);
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("z-[80]");
  });
});
