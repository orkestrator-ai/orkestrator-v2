import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  TRANSPORT_FAILURE,
  baseHandlers,
  callsOf,
  editableDocs,
  emitMcpChanged,
  install,
  invokeMock,
  preview,
  pressEnter,
  resetInvoke,
  snapshot,
} from "./mcp-test-fixtures";
import { ProviderMcpSettings } from "./ProviderMcpSettings";

afterEach(() => {
  cleanup();
  resetInvoke();
});

const CONFLICT = "McpManagementError:revision-conflict: The configuration changed.";
const saved = { operation: {}, replayed: false, savedRevision: "r1.two", entryId: "x" };

describe("enable/disable goes through a review", () => {
  test("disabling previews the fallback it reveals, then saves set-enabled", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({
        valid: true,
        fieldErrors: [],
        preview: {
          ...preview,
          changedFields: ["enabled"],
          revealsEntryId: "pi:user/x",
          revealsSourceLabel: "Pi user settings",
        },
      }),
      mutate_mcp_definition: () => saved,
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable docs" }));
    expect(await screen.findByText("Disable docs?")).toBeTruthy();
    expect(
      await screen.findByText(/same-name server from Pi user settings will become effective/),
    ).toBeTruthy();
    // Nothing is written until the user chooses.
    expect(callsOf("mutate_mcp_definition").length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(1));
    const [validated] = callsOf("validate_mcp_mutation");
    const [mutation] = callsOf("mutate_mcp_definition");
    expect(validated!.mutation.applyIntent).toBe("save-and-apply");
    expect(mutation!.mutation).toMatchObject({
      applyIntent: "save",
      operation: {
        kind: "set-enabled",
        entryId: "claude:user/ZG9jcw",
        expectedRevision: "r1.one",
        enabled: false,
      },
    });
  });

  test("enable and apply sends the same operation with save-and-apply", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({
          definitions: [{ ...snapshot().definitions[0]!, enabled: false, status: "disabled" }],
        }),
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => saved,
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enable and apply" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(1));
    expect(callsOf("mutate_mcp_definition")[0]!.mutation).toMatchObject({
      applyIntent: "save-and-apply",
      operation: { kind: "set-enabled", enabled: true },
    });
  });

  test("a toggle retried after a lost response keeps its request id and pinned revision", async () => {
    let revision = "r1.one";
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({ sources: [{ ...snapshot().sources[0]!, revision }] }),
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => {
        if (callsOf("mutate_mcp_definition").length === 1) throw new Error(TRANSPORT_FAILURE);
        return saved;
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(await screen.findByText(TRANSPORT_FAILURE)).toBeTruthy();

    revision = "r1.two";
    const reads = invokeMock.mock.calls.length;
    await emitMcpChanged();
    await waitFor(() => expect(invokeMock.mock.calls.length).toBeGreaterThan(reads));

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(2));
    const [lost, retried] = callsOf("mutate_mcp_definition");
    expect(retried!.mutation.requestId).toBe(lost!.mutation.requestId);
    expect(retried!.mutation.operation.expectedRevision).toBe("r1.one");
  });
});

describe("rename and remove recover from a conflict", () => {
  test("rename: reload latest re-pins the revision, mints new ids and needs a new preview", async () => {
    install({
      ...baseHandlers,
      get_mcp_definition: () => ({ ...editableDocs, sourceRevision: "r1.two" }),
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => {
        if (callsOf("mutate_mcp_definition").length === 1) throw new Error(CONFLICT);
        return saved;
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename docs" }));
    fireEvent.change(await screen.findByLabelText("New name"), { target: { value: "docs2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    fireEvent.click(await screen.findByRole("button", { name: "Reload latest and review again" }));
    // The old preview described the old file: it is gone until reviewed again.
    expect(await screen.findByRole("button", { name: "Review change" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename" }) === null).toBe(true);
    expect((screen.getByLabelText("New name") as HTMLInputElement).value).toBe("docs2");

    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(2));

    const [firstPreview, secondPreview] = callsOf("validate_mcp_mutation");
    const [conflicted, retried] = callsOf("mutate_mcp_definition");
    expect(firstPreview!.mutation.operation.expectedRevision).toBe("r1.one");
    expect(secondPreview!.mutation.operation.expectedRevision).toBe("r1.two");
    expect(secondPreview!.mutation.requestId).not.toBe(firstPreview!.mutation.requestId);
    expect(conflicted!.mutation.operation.expectedRevision).toBe("r1.one");
    expect(retried!.mutation.operation).toMatchObject({
      kind: "rename",
      expectedRevision: "r1.two",
      newName: "docs2",
    });
    expect(retried!.mutation.requestId).not.toBe(conflicted!.mutation.requestId);
  });

  test("remove: reload latest previews again against the new revision", async () => {
    install({
      ...baseHandlers,
      get_mcp_definition: () => ({ ...editableDocs, sourceRevision: "r1.two" }),
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => {
        if (callsOf("mutate_mcp_definition").length === 1) throw new Error(CONFLICT);
        return saved;
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload latest and review again" }));
    await waitFor(() => expect(callsOf("validate_mcp_mutation").length).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsOf("mutate_mcp_definition").length).toBe(2));
    const [conflicted, retried] = callsOf("mutate_mcp_definition");
    expect(callsOf("validate_mcp_mutation")[1]!.mutation.operation.expectedRevision).toBe("r1.two");
    expect(retried!.mutation.operation.expectedRevision).toBe("r1.two");
    expect(retried!.mutation.requestId).not.toBe(conflicted!.mutation.requestId);
  });
});

describe("focus returns to the row that opened a dialog", () => {
  const handlers = {
    ...baseHandlers,
    get_mcp_definition: () => editableDocs,
    validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
  };

  for (const [action, opened] of [
    ["Edit docs", "Edit docs"],
    ["Rename docs", "Rename docs"],
    ["Remove docs", "Remove docs?"],
    ["Disable docs", "Disable docs?"],
  ] as const) {
    test(`keyboard only: ${action}, then Escape`, async () => {
      install(handlers);
      render(<ProviderMcpSettings />);
      const trigger = await screen.findByRole("button", { name: action });
      pressEnter(trigger, fireEvent);
      await screen.findByRole("heading", { name: opened });
      // Radix moves focus into the dialog.
      await waitFor(() => expect(document.activeElement === trigger).toBe(false));

      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
        code: "Escape",
      });
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: opened }) === null).toBe(true),
      );
      await waitFor(() => expect(document.activeElement === trigger).toBe(true));
    });
  }

  test("the Add server button gets focus back after the add dialog closes", async () => {
    install(handlers);
    render(<ProviderMcpSettings />);
    const add = await screen.findByRole("button", { name: /Add server/ });
    pressEnter(add, fireEvent);
    await screen.findByRole("heading", { name: /Add Claude Code server/ });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement === add).toBe(true));
  });
});
