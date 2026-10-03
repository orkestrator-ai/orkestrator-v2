import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { pickHostPath } from "@/lib/host-path-picker";

type Listing = {
  path: string;
  parent: string | null;
  home: string;
  roots: string[];
  entries: { name: string; path: string; isDirectory: boolean }[];
  truncated: boolean;
};

const listings: Record<string, Listing> = {
  "/home/me": {
    path: "/home/me",
    parent: "/home",
    home: "/home/me",
    roots: ["/"],
    entries: [
      { name: "repo", path: "/home/me/repo", isDirectory: true },
      { name: "notes.txt", path: "/home/me/notes.txt", isDirectory: false },
    ],
    truncated: false,
  },
  "/home/me/repo": {
    path: "/home/me/repo",
    parent: "/home/me",
    home: "/home/me",
    roots: ["/"],
    entries: [{ name: "app.ts", path: "/home/me/repo/app.ts", isDirectory: false }],
    truncated: false,
  },
};

const invoke = mock(async (command: string, args?: Record<string, unknown>) => {
  if (command !== "list_host_directory") throw new Error(`unexpected command ${command}`);
  const listing = listings[(args?.path as string | undefined) ?? "/home/me"];
  if (!listing) throw new Error("not found");
  const entries = args?.includeFiles
    ? listing.entries
    : listing.entries.filter((entry) => entry.isDirectory);
  return { ...listing, entries };
});

mock.module("@/lib/native/backend", () => ({ invoke }));

const { HostPathPickerDialog } = await import("./HostPathPickerDialog");

beforeEach(() => invoke.mockClear());

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({
    invoke: mock(() => Promise.resolve()),
  }));
});

describe("HostPathPickerDialog", () => {
  test("selects the folder being browsed after navigating into a subfolder", async () => {
    render(<HostPathPickerDialog />);
    let result!: Promise<string | null>;
    act(() => {
      result = pickHostPath({ mode: "directory", title: "Pick a repo" });
    });

    expect(await screen.findByText("Pick a repo")).toBeTruthy();
    // Folder mode never asks the host for files.
    expect(invoke).toHaveBeenCalledWith("list_host_directory", {
      includeFiles: false,
      showHidden: false,
    });
    expectDomAbsent(screen.queryByText("notes.txt"), "file row in folder mode");

    fireEvent.click(await screen.findByRole("button", { name: "repo" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/me/repo"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));

    await expect(result).resolves.toBe("/home/me/repo");
  });

  test("file mode needs a file selected before it can confirm", async () => {
    render(<HostPathPickerDialog />);
    let result!: Promise<string | null>;
    act(() => {
      result = pickHostPath({ mode: "file", defaultPath: "/home/me" });
    });

    const confirm = await screen.findByRole("button", { name: "Select file" });
    expect(invoke).toHaveBeenCalledWith("list_host_directory", {
      path: "/home/me",
      includeFiles: true,
      showHidden: false,
    });
    await screen.findByText("notes.txt");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);

    await expect(result).resolves.toBe("/home/me/notes.txt");
  });

  test("resolves null when cancelled", async () => {
    render(<HostPathPickerDialog />);
    let result!: Promise<string | null>;
    act(() => {
      result = pickHostPath({ mode: "directory" });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await expect(result).resolves.toBeNull();
  });

  test("a newer request cancels the one still open", async () => {
    render(<HostPathPickerDialog />);
    let first!: Promise<string | null>;
    act(() => {
      first = pickHostPath({ mode: "directory" });
    });
    await screen.findByRole("button", { name: "Select this folder" });

    act(() => {
      void pickHostPath({ mode: "file" });
    });

    await expect(first).resolves.toBeNull();
  });

  test("shows a listing failure instead of a stale folder", async () => {
    render(<HostPathPickerDialog />);
    act(() => {
      void pickHostPath({ mode: "directory", defaultPath: "/nope" });
    });

    expect((await screen.findByRole("alert")).textContent).toContain("not found");
  });
});
