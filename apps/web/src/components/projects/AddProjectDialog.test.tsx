import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  GitHubCloneAccount,
  GitHubCloneRepository,
  GitHubCloneRepositoryList,
} from "@orkestrator/protocol/github-clone";
import { AddProjectDialog } from "./AddProjectDialog";
import {
  joinHostPath,
  normalizeGitHubRemote,
  suggestedCloneDirectory,
} from "./GitHubRepositoryPicker";

afterEach(cleanup);

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
  render(
    <AddProjectDialog
      open
      onOpenChange={onOpenChange}
      onAdd={onAdd}
      onCreate={onCreate}
      validateGitUrl={validateGitUrl}
      loadGitHubAccounts={loadGitHubAccounts}
      loadGitHubRepositories={loadGitHubRepositories}
      {...overrides}
    />,
  );
  return { onOpenChange, onAdd, onCreate, validateGitUrl, loadGitHubRepositories };
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

    expect(loadGitHubRepositories).toHaveBeenCalledWith("acme");
    expect(listedNames("repositories")).toEqual(["web", "billing", "api"]);

    fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
    expect(listedNames("repositories")).toEqual(["api", "billing", "web"]);

    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "bil" } });
    expect(listedNames("repositories")).toEqual(["billing"]);
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
