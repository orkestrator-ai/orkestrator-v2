import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { pickHostPath, useHostPathPickerStore } from "@/lib/host-path-picker";

type Listing = {
  path: string;
  parent: string | null;
  home: string;
  roots: string[];
  entries: { name: string; path: string; isDirectory: boolean }[];
  truncated: boolean;
  requestedFile?: string | null;
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

const defaultInvoke = async (command: string, args?: Record<string, unknown>): Promise<Listing> => {
  if (command !== "list_host_directory") throw new Error(`unexpected command ${command}`);
  const listing = listings[(args?.path as string | undefined) ?? "/home/me"];
  if (!listing) throw new Error("not found");
  const entries = args?.includeFiles
    ? listing.entries
    : listing.entries.filter((entry) => entry.isDirectory);
  return { ...listing, entries };
};
const invoke = mock(defaultInvoke);

mock.module("@/lib/native/backend", () => ({ invoke }));

const { HostPathPickerDialog } = await import("./HostPathPickerDialog");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(defaultInvoke);
});

afterEach(() => {
  act(() => useHostPathPickerStore.getState().settle(null));
  cleanup();
});

function submitPath(path: string) {
  const input = screen.getByLabelText("Path");
  fireEvent.change(input, { target: { value: path } });
  fireEvent.submit(input.closest("form")!);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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
  for (const mode of ["directory", "file"] as const) {
    test(`${mode} mode cannot confirm a previous path after failed navigation`, async () => {
      render(<HostPathPickerDialog />);
      let result!: Promise<string | null>;
      act(() => {
        result = pickHostPath({ mode });
      });
      await screen.findByRole("button", { name: "repo" });
      if (mode === "file") fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
      submitPath("/nope");
      await screen.findByRole("alert");
      const confirm = screen.getByRole("button", {
        name: mode === "file" ? "Select file" : "Select this folder",
      });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      fireEvent.click(confirm);
      expect(useHostPathPickerStore.getState().request !== null).toBe(true);
      expectDomAbsent(screen.queryByRole("button", { name: "repo" }), "stale folder row");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expect(result).resolves.toBeNull();
    });
  }

  test("blocks stale file row clicks and double-clicks while navigation is pending", async () => {
    render(<HostPathPickerDialog />);
    act(() => {
      void pickHostPath({ mode: "file" });
    });
    const row = await screen.findByRole("button", { name: "notes.txt" });
    fireEvent.click(row);
    const pending = deferred<Listing>();
    invoke.mockImplementationOnce(() => pending.promise);
    submitPath("/home/me/repo");
    expect(row.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(useHostPathPickerStore.getState().request !== null).toBe(true);
    expect(screen.getByRole("button", { name: "Select file" }).hasAttribute("disabled")).toBe(true);
    await act(async () => pending.resolve(listings["/home/me/repo"]!));
    expect(useHostPathPickerStore.getState().request !== null).toBe(true);
  });

  test("double-clicking a current file settles the request", async () => {
    render(<HostPathPickerDialog />);
    let result!: Promise<string | null>;
    act(() => {
      result = pickHostPath({ mode: "file" });
    });
    fireEvent.doubleClick(await screen.findByRole("button", { name: "notes.txt" }));
    await expect(result).resolves.toBe("/home/me/notes.txt");
  });

  for (const typed of ["~/notes.txt", "/home/me/repo/../notes.txt"]) {
    test(`selects the backend-normalized typed file ${typed} outside the capped entries`, async () => {
      render(<HostPathPickerDialog />);
      let result!: Promise<string | null>;
      act(() => {
        result = pickHostPath({ mode: "file" });
      });
      await screen.findByText("notes.txt");
      invoke.mockImplementationOnce(async () => ({
        ...listings["/home/me"]!,
        entries: [],
        truncated: true,
        requestedFile: "/home/me/notes.txt",
      }));
      submitPath(typed);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Select file" }).hasAttribute("disabled")).toBe(
          false,
        ),
      );
      expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/me");
      expect(screen.getByText("Selected file: /home/me/notes.txt")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Select file" }));
      await expect(result).resolves.toBe("/home/me/notes.txt");
    });
  }

  test("hidden toggle refreshes the current folder and shows the truncation notice", async () => {
    render(<HostPathPickerDialog />);
    act(() => {
      void pickHostPath({ mode: "file" });
    });
    await screen.findByText("notes.txt");
    invoke.mockImplementationOnce(async () => ({
      ...listings["/home/me"]!,
      truncated: true,
      entries: [{ name: ".env", path: "/home/me/.env", isDirectory: false }],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Hidden items" }));
    await screen.findByRole("button", { name: ".env" });
    expect(invoke).toHaveBeenLastCalledWith("list_host_directory", {
      path: "/home/me",
      includeFiles: true,
      showHidden: true,
    });
    expect(screen.getByRole("button", { name: "Hidden items" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText(/Only the first entries/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hidden items" }));
    await screen.findByText("notes.txt");
  });

  test("parent, home and drive-root buttons navigate the host", async () => {
    invoke.mockImplementation(async (_command, args) => ({
      ...listings["/home/me"]!,
      path: (args?.path as string) || "/home/me/repo",
      roots: ["C:\\", "D:\\"],
    }));
    render(<HostPathPickerDialog />);
    act(() => {
      void pickHostPath({ mode: "directory" });
    });
    await screen.findByText("repo");
    for (const [button, destination] of [
      ["Parent folder", "/home"],
      ["Home folder", "/home/me"],
      ["D:\\", "D:\\"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: button! }));
      await waitFor(() =>
        expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe(destination!),
      );
    }
  });

  test("late successful and failed responses cannot replace a newer navigation", async () => {
    render(<HostPathPickerDialog />);
    act(() => {
      void pickHostPath({ mode: "directory" });
    });
    await screen.findByText("repo");
    const older = deferred<Listing>();
    const newer = deferred<Listing>();
    invoke.mockImplementationOnce(() => older.promise);
    invoke.mockImplementationOnce(() => newer.promise);
    submitPath("/older");
    submitPath("/newer");
    await act(async () => newer.resolve({ ...listings["/home/me/repo"]!, path: "/newer" }));
    await act(async () => older.resolve({ ...listings["/home/me"]!, path: "/older" }));
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/newer");
    const failing = deferred<Listing>();
    invoke.mockImplementationOnce(() => failing.promise);
    submitPath("/failing");
    submitPath("/home/me");
    await screen.findByText("repo");
    await act(async () => failing.reject(new Error("late failure")));
    expectDomAbsent(screen.queryByRole("alert"), "obsolete failure");
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/me");
  });
  test("a cancelled request's late response cannot affect its replacement", async () => {
    const old = deferred<Listing>();
    invoke.mockImplementationOnce(() => old.promise);
    render(<HostPathPickerDialog />);
    let first!: Promise<string | null>;
    let replacement!: Promise<string | null>;
    act(() => {
      first = pickHostPath({ mode: "file" });
    });
    act(() => {
      replacement = pickHostPath({ mode: "directory", defaultPath: "/home/me/repo" });
    });
    await expect(first).resolves.toBeNull();
    await waitFor(() =>
      expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/me/repo"),
    );
    await act(async () =>
      old.resolve({ ...listings["/home/me"]!, requestedFile: "/home/me/notes.txt" }),
    );
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/me/repo");
    fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
    await expect(replacement).resolves.toBe("/home/me/repo");
  });
});
