import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  GitHubCloneAccount,
  GitHubCloneRepository,
  GitHubCloneRepositoryList,
} from "@orkestrator/protocol/github-clone";
import { AddProjectDialog } from "./AddProjectDialog";
import { joinHostPath, normalizeGitHubRemote, suggestedCloneDirectory } from "@/lib/github-clone";

import { toast } from "sonner";
import { useHostPathPickerStore } from "@/lib/host-path-picker";

afterEach(() => {
  cleanup();
  useHostPathPickerStore.getState().settle(null);
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {}) {
  const onOpenChange = mock((_open: boolean) => undefined);
  const onAdd = mock(async (_gitUrl: string, _localPath?: string) => undefined);
  const onCreate = mock(async (_localPath: string) => undefined);
  const validateGitUrl = mock(async (_url: string) => true);
  const loadGitHubAccounts = mock(async (): Promise<GitHubCloneAccount[]> => GITHUB_ACCOUNTS);
  const loadGitHubRepositories = mock(
    async (_owner: string): Promise<GitHubCloneRepositoryList> => ({
      repositories: GITHUB_REPOSITORIES,
      truncated: false,
    }),
  );
  const props = {
    open: true,
    onOpenChange,
    onAdd,
    onCreate,
    validateGitUrl,
    loadGitHubAccounts,
    loadGitHubRepositories,
    ...overrides,
  };
  const view = render(<AddProjectDialog {...props} />);
  return {
    onOpenChange,
    onAdd,
    onCreate,
    validateGitUrl,
    loadGitHubRepositories,
    rerenderOpen: (open: boolean) => view.rerender(<AddProjectDialog {...props} open={open} />),
    unmount: view.unmount,
  };
}

const GITHUB_ACCOUNTS: GitHubCloneAccount[] = [
  { login: "zeta-labs", kind: "organization" },
  { login: "acme", kind: "organization" },
  { login: "octocat", kind: "user" },
];

function githubRepository(name: string, updatedAt: string): GitHubCloneRepository {
  return {
    name,
    fullName: `acme/${name}`,
    description: `${name} description`,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    updatedAt,
    cloneUrl: `https://github.com/acme/${name}.git`,
  };
}

const GITHUB_REPOSITORIES = [
  githubRepository("api", "2026-01-01T00:00:00Z"),
  githubRepository("web", "2026-09-01T00:00:00Z"),
  githubRepository("billing", "2026-05-01T00:00:00Z"),
];

function listedNames(listName: string): string[] {
  return Array.from(
    screen.getByRole("list", { name: listName }).querySelectorAll("button"),
    (button) => button.querySelector("span")?.textContent ?? "",
  );
}

async function openGitHubRepositories() {
  fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
  await screen.findByRole("list", { name: "organizations" });
  fireEvent.click(screen.getByRole("button", { name: /^acme/ }));
  await screen.findByRole("list", { name: "repositories" });
}

describe("AddProjectDialog", () => {
  test("renders the source selector as option cards and preserves active state", () => {
    renderDialog();

    const existingTab = screen.getByRole("tab", { name: "Existing repository" });
    const createTab = screen.getByRole("tab", { name: "Create new" });
    const tabList = screen.getByRole("tablist");

    expect(tabList.className).toContain("gap-2");
    expect(tabList.className).toContain("bg-transparent");
    expect(tabList.className).toContain("p-0");

    for (const tab of [existingTab, createTab]) {
      expect(tab.className).toContain("border-2");
      expect(tab.className).toContain("p-3");
      expect(tab.className).toContain("justify-start");
      expect(tab.className).toContain("data-[state=active]:!border-primary");
      expect(tab.className).toContain("data-[state=inactive]:!bg-zinc-900");
      expect(tab.className).toContain("hover:data-[state=inactive]:border-zinc-600");
    }

    expect(existingTab.getAttribute("data-state")).toBe("active");
    expect(createTab.getAttribute("data-state")).toBe("inactive");
    expect(
      screen.getByText("Select a local clone, or enter a new path to clone this repository there."),
    ).toBeTruthy();

    fireEvent.mouseDown(createTab, { button: 0 });

    expect(existingTab.getAttribute("data-state")).toBe("inactive");
    expect(createTab.getAttribute("data-state")).toBe("active");
  });

  test("submits a typed destination path with the Git URL", async () => {
    const { onAdd, onCreate, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });
    fireEvent.change(screen.getByLabelText(/Local path/), {
      target: { value: "/Users/dev/Projects/missing-copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        "https://github.com/acme/project.git",
        "/Users/dev/Projects/missing-copy",
      );
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("keeps the dialog open when adding a typed missing path fails", async () => {
    const onAdd = mock(async () => {
      throw new Error("Could not clone the Git repository: authentication failed");
    });
    const { onOpenChange } = renderDialog({ onAdd });

    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });
    fireEvent.change(screen.getByLabelText(/Local path/), {
      target: { value: "/Users/dev/Projects/missing-copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not clone the Git repository: authentication failed",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("creates a new private project from the selected target path", async () => {
    const { onCreate, onAdd, onOpenChange } = renderDialog();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Create new" }), { button: 0 });
    expect(screen.getByText("Private origin")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Project path/), {
      target: { value: "/Users/dev/Projects/new-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("/Users/dev/Projects/new-app");
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("keeps the dialog open and displays a creation failure", async () => {
    const onCreate = mock(async () => {
      throw new Error("GitHub CLI is not authenticated");
    });
    const { onOpenChange } = renderDialog({ onCreate });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Create new" }), { button: 0 });
    fireEvent.change(screen.getByLabelText(/Project path/), {
      target: { value: "/Users/dev/Projects/new-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub CLI is not authenticated",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("lists GitHub organizations alphabetically and filters them by search", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
    await screen.findByRole("list", { name: "organizations" });

    expect(listedNames("organizations")).toEqual(["acme", "octocat", "zeta-labs"]);

    fireEvent.change(screen.getByLabelText("Search organizations"), {
      target: { value: "LABS" },
    });
    expect(listedNames("organizations")).toEqual(["zeta-labs"]);
  });

  test("orders repositories by most recent update with an alphabetical toggle", async () => {
    const { loadGitHubRepositories } = renderDialog();
    await openGitHubRepositories();

    expect(loadGitHubRepositories).toHaveBeenCalledWith("acme", undefined);
    expect(listedNames("repositories")).toEqual(["web", "billing", "api"]);

    fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
    expect(listedNames("repositories")).toEqual(["api", "billing", "web"]);

    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "bil" } });
    expect(listedNames("repositories")).toEqual(["billing"]);
  });

  test("truncates long repository descriptions within the dialog width", async () => {
    const description = "A very long repository description ".repeat(10).trim();
    renderDialog({
      loadGitHubRepositories: mock(async () => ({
        repositories: [{ ...githubRepository("web", "2026-09-01T00:00:00Z"), description }],
        truncated: false,
      })),
    });
    await openGitHubRepositories();

    const descriptionText = screen.getByText(description);
    expect(descriptionText.className).toContain("truncate");
    expect(descriptionText.getAttribute("title")).toBe(description);
    // The picker sits in the dialog's grid; without min-w-0 the unwrapped
    // description widens the grid column past the dialog edge.
    const pickerRoot = screen.getByLabelText("Search repositories").closest(".space-y-3");
    expect(pickerRoot?.className).toContain("min-w-0");
  });

  test("clones the chosen repository into the chosen local path", async () => {
    const { onAdd, onOpenChange } = renderDialog({
      defaultCloneDirectory: "/Users/dev/Projects/",
    });
    await openGitHubRepositories();

    fireEvent.click(screen.getByRole("button", { name: /^web/ }));
    const pathInput = screen.getByLabelText(/Local path/) as HTMLInputElement;
    expect(pathInput.value).toBe("/Users/dev/Projects/web");

    fireEvent.change(pathInput, { target: { value: "/Users/dev/code/web-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone project" }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        "https://github.com/acme/web.git",
        "/Users/dev/code/web-app",
        true,
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("keeps the GitHub picker open when cloning fails", async () => {
    const onAdd = mock(async () => {
      throw new Error("Could not clone the Git repository: authentication failed");
    });
    const { onOpenChange } = renderDialog({ onAdd });
    await openGitHubRepositories();

    fireEvent.click(screen.getByRole("button", { name: /^api/ }));
    fireEvent.change(screen.getByLabelText(/Local path/), {
      target: { value: "/Users/dev/Projects/api" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not clone the Git repository: authentication failed",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clone project" })).toBeTruthy();
  });

  test("disables repositories that are already projects", async () => {
    renderDialog({ existingGitUrls: ["git@github.com:Acme/api.git"] });
    await openGitHubRepositories();

    const api = screen.getByRole("button", { name: /^api/ }) as HTMLButtonElement;
    expect(api.disabled).toBe(true);
    expect(api.textContent).toContain("Already added");
  });

  test("shows a GitHub CLI failure with a retry", async () => {
    let attempts = 0;
    const loadGitHubAccounts = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("GitHub CLI is not installed");
      return GITHUB_ACCOUNTS;
    });
    renderDialog({ loadGitHubAccounts });

    fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toContain("GitHub CLI is not installed");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "organizations" });
    expect(loadGitHubAccounts).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub clone path helpers", () => {
  test("suggests the folder most projects share", () => {
    expect(
      suggestedCloneDirectory([
        "/Users/dev/work/one",
        null,
        "/Users/dev/Projects/two",
        "/Users/dev/Projects/three/",
      ]),
    ).toBe("/Users/dev/Projects");
    expect(suggestedCloneDirectory([])).toBeUndefined();
  });

  test("joins paths with the directory's separator", () => {
    expect(joinHostPath("/Users/dev/Projects/", "web")).toBe("/Users/dev/Projects/web");
    expect(joinHostPath("C:\\code", "web")).toBe("C:\\code\\web");
    expect(joinHostPath("/", "web")).toBe("/web");
  });

  test("compares remotes across protocols", () => {
    expect(normalizeGitHubRemote("git@github.com:Acme/API.git")).toBe("github.com/acme/api");
    expect(normalizeGitHubRemote("https://github.com/acme/api")).toBe("github.com/acme/api");
    expect(normalizeGitHubRemote("ssh://git@github.com/acme/api.git")).toBe("github.com/acme/api");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function chooseClone(name = "api") {
  await openGitHubRepositories();
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  fireEvent.change(screen.getByLabelText(/Local path/), { target: { value: `/code/${name}` } });
  fireEvent.click(screen.getByRole("button", { name: "Clone project" }));
}

describe("GitHub clone lifecycle and navigation", () => {
  for (const outcome of ["success", "failure"] as const) {
    test(`prevents dismissal during a clone and displays its ${outcome}`, async () => {
      const pending = deferred<void>();
      const { onOpenChange } = renderDialog({ onAdd: () => pending.promise });
      await chooseClone();
      expect(screen.queryByRole("button", { name: "Close" }) === null).toBe(true);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
      fireEvent.pointerDown(overlay);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Cloning…" }).hasAttribute("disabled")).toBe(true);
      await act(async () => {
        if (outcome === "success") pending.resolve();
        else pending.reject(new Error("clone failed"));
      });
      if (outcome === "success") expect(onOpenChange).toHaveBeenCalledWith(false);
      else {
        expect(screen.getByRole("alert").textContent).toContain("clone failed");
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      }
    });

    test(`a previous clone's ${outcome} cannot reset a reopened selection`, async () => {
      const pending = deferred<void>();
      const notice = spyOn(toast, outcome === "success" ? "success" : "error").mockImplementation(
        () => "notice",
      );
      try {
        const { onOpenChange, rerenderOpen } = renderDialog({ onAdd: () => pending.promise });
        await chooseClone();
        // A parent may force the controlled dialog closed even though UI dismissal is blocked.
        rerenderOpen(false);
        rerenderOpen(true);
        await openGitHubRepositories();
        fireEvent.click(screen.getByRole("button", { name: /^billing/ }));
        fireEvent.change(screen.getByLabelText(/Local path/), {
          target: { value: "/code/new-billing" },
        });
        await act(async () => {
          if (outcome === "success") pending.resolve();
          else pending.reject(new Error("old clone failed"));
        });
        expect(onOpenChange).not.toHaveBeenCalled();
        expect((screen.getByLabelText(/Local path/) as HTMLInputElement).value).toBe(
          "/code/new-billing",
        );
        expect(screen.queryByRole("alert") === null).toBe(true);
        expect(notice).not.toHaveBeenCalled();
      } finally {
        notice.mockRestore();
      }
    });

    test(`leaves clone ${outcome} notifications to the caller after the dialog component unmounts`, async () => {
      const pending = deferred<void>();
      const notice = spyOn(toast, outcome === "success" ? "success" : "error").mockImplementation(
        () => "notice",
      );
      try {
        const { unmount, onOpenChange } = renderDialog({ onAdd: () => pending.promise });
        await chooseClone();
        unmount();
        await act(async () => {
          if (outcome === "success") pending.resolve();
          else pending.reject(new Error("background clone failed"));
        });
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(notice).not.toHaveBeenCalled();
      } finally {
        notice.mockRestore();
      }
    });
  }

  test("retries repository failures and shows pagination, then reuses cached data from the path step", async () => {
    const loadGitHubRepositories = mock(async () => ({
      repositories: GITHUB_REPOSITORIES,
      truncated: true,
      nextCursor: "next",
    }));
    loadGitHubRepositories.mockRejectedValueOnce(new Error("repository listing failed"));
    renderDialog({ loadGitHubRepositories });
    fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
    await screen.findByRole("list", { name: "organizations" });
    fireEvent.click(screen.getByRole("button", { name: /^acme/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("repository listing failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "repositories" });
    expect(screen.getByText(/3 repositories loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^api/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    await screen.findByRole("list", { name: "repositories" });
    expect(loadGitHubRepositories).toHaveBeenCalledTimes(2);
  });

  test("retains loaded repositories and retries a failed next page using the same cursor", async () => {
    const loadGitHubRepositories = mock(
      async (_owner: string, _cursor?: string): Promise<GitHubCloneRepositoryList> => ({
        repositories: [githubRepository("later", "")],
        truncated: false,
      }),
    );
    loadGitHubRepositories.mockResolvedValueOnce({
      repositories: GITHUB_REPOSITORIES,
      truncated: true,
      nextCursor: "page-two",
    });
    loadGitHubRepositories.mockRejectedValueOnce(new Error("page failed"));
    renderDialog({ loadGitHubRepositories });
    await openGitHubRepositories();
    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
    expect((await screen.findByRole("alert")).textContent).toContain("page failed");
    expect(listedNames("repositories")).toEqual(["web", "billing", "api"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading more" }));
    await screen.findByRole("button", { name: /^later/ });
    expect(loadGitHubRepositories.mock.calls).toEqual([
      ["acme", undefined],
      ["acme", "page-two"],
      ["acme", "page-two"],
    ]);
    expect(screen.queryByRole("button", { name: "Load more repositories" }) === null).toBe(true);
    expect(listedNames("repositories")).toEqual(["web", "billing", "api", "later"]);
  });

  test("ignores cancelled owner responses and refetches when returning to a loading owner", async () => {
    const old = deferred<GitHubCloneRepositoryList>();
    const other = deferred<GitHubCloneRepositoryList>();
    const fresh = deferred<GitHubCloneRepositoryList>();
    const loadGitHubRepositories = mock(() => fresh.promise);
    loadGitHubRepositories.mockReturnValueOnce(old.promise).mockReturnValueOnce(other.promise);
    renderDialog({ loadGitHubRepositories });
    fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
    await screen.findByRole("list", { name: "organizations" });
    fireEvent.click(screen.getByRole("button", { name: /^acme/ }));
    await waitFor(() => expect(loadGitHubRepositories).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }));
    fireEvent.click(screen.getByRole("button", { name: /^zeta-labs/ }));
    await waitFor(() => expect(loadGitHubRepositories).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }));
    fireEvent.click(screen.getByRole("button", { name: /^acme/ }));
    await waitFor(() => expect(loadGitHubRepositories).toHaveBeenCalledTimes(3));
    await act(async () => {
      old.resolve({ repositories: [githubRepository("stale", "")], truncated: false });
      other.reject(new Error("cancelled owner failed"));
    });
    expect(screen.queryByRole("list", { name: "repositories" }) === null).toBe(true);
    expect(screen.queryByRole("alert") === null).toBe(true);
    await act(async () => fresh.resolve({ repositories: GITHUB_REPOSITORIES, truncated: false }));
    expect(listedNames("repositories")).toEqual(["web", "billing", "api"]);
  });

  test("folder selection appends the repository name and clears a clone error", async () => {
    renderDialog({
      onAdd: async () => {
        throw new Error("destination occupied");
      },
    });
    await chooseClone();
    expect((await screen.findByRole("alert")).textContent).toContain("destination occupied");
    fireEvent.click(screen.getByRole("button", { name: "Choose clone folder" }));
    expect(useHostPathPickerStore.getState().request?.defaultPath).toBe("/code");
    await act(async () => useHostPathPickerStore.getState().settle("/new-parent/"));
    expect((screen.getByLabelText(/Local path/) as HTMLInputElement).value).toBe("/new-parent/api");
    expect(screen.queryByRole("alert") === null).toBe(true);
  });
});
