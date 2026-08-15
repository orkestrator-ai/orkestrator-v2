import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as realBackend from "@/lib/backend";
import * as realNativeDialog from "@/lib/native/dialog";

const realBackendSnapshot = { ...realBackend };
const realNativeDialogSnapshot = { ...realNativeDialog };
const openDialogMock = mock(async (): Promise<string | null> => null);
const getGitRemoteUrlMock = mock(async (): Promise<string | null> => null);
const originalGateway = window.orkestratorGateway;

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getGitRemoteUrl: getGitRemoteUrlMock,
}));

mock.module("@/lib/native/dialog", () => ({
  ...realNativeDialogSnapshot,
  open: openDialogMock,
}));

const { AddProjectDialog } = await import(
  "../../../apps/web/src/components/projects/AddProjectDialog"
);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/native/dialog", () => realNativeDialogSnapshot);
});

describe("AddProjectDialog", () => {
  beforeEach(() => {
    delete window.orkestratorGateway;
    openDialogMock.mockReset();
    openDialogMock.mockResolvedValue(null);
    getGitRemoteUrlMock.mockReset();
    getGitRemoteUrlMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    window.orkestratorGateway = originalGateway;
  });

  test("caps the dialog width at 2xl", () => {
    render(
      <AddProjectDialog
        open
        onOpenChange={() => {}}
        onAdd={async () => {}}
        onCreate={async () => {}}
        validateGitUrl={async () => true}
      />
    );

    expect(screen.getByRole("dialog").className).toContain("sm:max-w-2xl");
  });

  test("detects the Git remote for a path entered in a browser client", async () => {
    window.orkestratorGateway = { enabled: true };
    const validateGitUrl = mock(async () => true);
    getGitRemoteUrlMock.mockResolvedValue("git@github.com:acme/project.git");

    render(
      <AddProjectDialog
        open
        onOpenChange={() => {}}
        onAdd={async () => {}}
        onCreate={async () => {}}
        validateGitUrl={validateGitUrl}
      />
    );

    fireEvent.change(screen.getByLabelText(/Local path/i), {
      target: { value: "/srv/repos/project" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    await waitFor(() => {
      expect(getGitRemoteUrlMock).toHaveBeenCalledWith("/srv/repos/project");
    });
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select repository directory",
      defaultPath: "/srv/repos/project",
    });
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "git@github.com:acme/project.git"
    );
    expect(validateGitUrl).toHaveBeenCalledWith("git@github.com:acme/project.git");
  });

  test("detects the Git remote for a directory selected by the native picker", async () => {
    const validateGitUrl = mock(async () => true);
    openDialogMock.mockResolvedValue("/Users/alice/project");
    getGitRemoteUrlMock.mockResolvedValue("https://github.com/acme/project.git");

    renderDialog({ validateGitUrl });
    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    await waitFor(() => {
      expect(getGitRemoteUrlMock).toHaveBeenCalledWith("/Users/alice/project");
    });
    expect((screen.getByLabelText(/Local path/i) as HTMLInputElement).value).toBe(
      "/Users/alice/project"
    );
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/project.git"
    );
  });

  test("does not inspect the typed path when the native picker is cancelled", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Local path/i), {
      target: { value: "/Users/alice/project" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalledTimes(1));
    expect(getGitRemoteUrlMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("");
  });

  test("does nothing when browser detection has no entered path", async () => {
    window.orkestratorGateway = { enabled: true };
    renderDialog();

    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalledTimes(1));
    expect(getGitRemoteUrlMock).not.toHaveBeenCalled();
  });

  test("keeps the current Git URL when the selected directory has no remote", async () => {
    const validateGitUrl = mock(async () => true);
    openDialogMock.mockResolvedValue("/Users/alice/no-remote");
    renderDialog({ validateGitUrl });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/existing.git" },
    });
    await waitFor(() => expect(validateGitUrl).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    await waitFor(() => {
      expect(getGitRemoteUrlMock).toHaveBeenCalledWith("/Users/alice/no-remote");
    });
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/existing.git"
    );
  });

  test("logs directory picker and repository inspection failures", async () => {
    const originalConsoleError = console.error;
    const originalConsoleDebug = console.debug;
    const consoleErrorMock = mock(() => undefined);
    const consoleDebugMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;
    console.debug = consoleDebugMock as typeof console.debug;

    try {
      openDialogMock.mockRejectedValueOnce(new Error("picker failed"));
      renderDialog();
      fireEvent.click(screen.getByRole("button", {
        name: "Select or detect repository directory",
      }));
      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to open directory picker:",
        expect.any(Error),
      ));

      openDialogMock.mockResolvedValueOnce("/Users/alice/not-git");
      getGitRemoteUrlMock.mockRejectedValueOnce(new Error("not a repository"));
      fireEvent.click(screen.getByRole("button", {
        name: "Select or detect repository directory",
      }));
      await waitFor(() => expect(consoleDebugMock).toHaveBeenCalledWith(
        "Could not get git remote URL:",
        expect.any(Error),
      ));
    } finally {
      console.error = originalConsoleError;
      console.debug = originalConsoleDebug;
    }
  });

  test("shows invalid state for a detected invalid remote", async () => {
    const validateGitUrl = mock(async () => false);
    openDialogMock.mockResolvedValue("/Users/alice/project");
    getGitRemoteUrlMock.mockResolvedValue("invalid-remote");
    renderDialog({ validateGitUrl });

    fireEvent.click(screen.getByRole("button", {
      name: "Select or detect repository directory",
    }));

    expect(await screen.findByText("Enter a valid Git URL (SSH or HTTPS format)")).toBeTruthy();
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("invalid-remote");
  });

  test("ignores stale URL validation results", async () => {
    let resolveFirst: ((valid: boolean) => void) | undefined;
    let resolveSecond: ((valid: boolean) => void) | undefined;
    const validateGitUrl = mock((url: string) => new Promise<boolean>((resolve) => {
      if (url.includes("first")) resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    renderDialog({ validateGitUrl });
    const gitUrlInput = screen.getByLabelText(/Git URL/);

    fireEvent.change(gitUrlInput, { target: { value: "https://github.com/acme/first.git" } });
    fireEvent.change(gitUrlInput, { target: { value: "https://github.com/acme/second.git" } });
    await act(async () => resolveSecond?.(true));
    await act(async () => resolveFirst?.(false));

    expect(gitUrlInput.className).toContain("border-green-500");
    expect(screen.queryByText("Enter a valid Git URL (SSH or HTTPS format)") === null).toBe(true);
  });

  test("shows URL validation failures without leaving an unhandled rejection", async () => {
    renderDialog({
      validateGitUrl: mock(async () => {
        throw new Error("validation service unavailable");
      }),
    });

    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });

    expect(await screen.findByText("validation service unavailable")).toBeTruthy();
    expect(screen.getByText("Enter a valid Git URL (SSH or HTTPS format)")).toBeTruthy();
  });

  test("shows a generic message for a non-Error URL validation failure", async () => {
    renderDialog({
      validateGitUrl: mock(async () => {
        throw "failed";
      }),
    });

    fireEvent.change(screen.getByLabelText(/Git URL/i), {
      target: { value: "https://github.com/acme/project.git" },
    });

    expect(await screen.findByText("Failed to validate Git URL")).toBeTruthy();
  });

  test("does not add an existing project with an empty Git URL", async () => {
    const onAdd = mock(async () => undefined);
    renderDialog({ onAdd });
    const submitButton = screen.getByRole("button", { name: "Add project" });

    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submitButton.closest("form")!);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Git URL is required",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("submits trimmed values and resets after success", async () => {
    const onAdd = mock(async () => undefined);
    const onOpenChange = mock(() => undefined);
    renderDialog({ onAdd, onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "  https://github.com/acme/project.git  " },
    });
    fireEvent.change(screen.getByLabelText(/Local path/i), {
      target: { value: "  /Users/alice/project  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      "https://github.com/acme/project.git",
      "/Users/alice/project",
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Local path/i) as HTMLInputElement).value).toBe("");
  });

  test("keeps the dialog state and shows a generic non-Error submission failure", async () => {
    const onAdd = mock(async () => {
      throw "failed";
    });
    const onOpenChange = mock(() => undefined);
    renderDialog({ onAdd, onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByText("Failed to add project")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/project.git"
    );
  });

  test("shows an existing-project Error message and omits a blank local path", async () => {
    const onAdd = mock(async (_gitUrl: string, localPath?: string) => {
      expect(localPath).toBeUndefined();
      throw new Error("repository already exists");
    });
    renderDialog({ onAdd });
    fireEvent.change(screen.getByLabelText(/Git URL/i), {
      target: { value: "https://github.com/acme/project.git" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "repository already exists",
    );
    expect(onAdd).toHaveBeenCalledWith("https://github.com/acme/project.git", undefined);
  });

  test("blocks submission after URL validation reports invalid", async () => {
    const onAdd = mock(async () => undefined);
    renderDialog({ onAdd, validateGitUrl: mock(async () => false) });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "invalid" },
    });
    await screen.findByText("Enter a valid Git URL (SSH or HTTPS format)");

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByText("Invalid Git URL format")).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("cancel clears the form and reports the close request", async () => {
    const onOpenChange = mock(() => undefined);
    renderDialog({ onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });
    fireEvent.change(screen.getByLabelText(/Local path/i), {
      target: { value: "/Users/alice/project" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Local path/i) as HTMLInputElement).value).toBe("");
  });

  test("selects a scratch project path with the native picker", async () => {
    openDialogMock.mockResolvedValue("/Users/alice/new-project");
    renderDialog();
    selectScratchTab();

    fireEvent.click(screen.getByRole("button", { name: "Choose an empty project folder" }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose an empty project folder",
      defaultPath: undefined,
    }));
    expect((screen.getByLabelText(/Project path/i) as HTMLInputElement).value).toBe(
      "/Users/alice/new-project",
    );
  });

  test("uses the typed scratch path when the gateway picker has no native result", async () => {
    window.orkestratorGateway = { enabled: true };
    renderDialog();
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "  /srv/projects/new-project  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose an empty project folder" }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose an empty project folder",
      defaultPath: "/srv/projects/new-project",
    }));
    expect((screen.getByLabelText(/Project path/i) as HTMLInputElement).value).toBe(
      "/srv/projects/new-project",
    );
  });

  test("preserves the typed scratch path when the native picker is cancelled", async () => {
    renderDialog();
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "/Users/alice/new-project" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose an empty project folder" }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText(/Project path/i) as HTMLInputElement).value).toBe(
      "/Users/alice/new-project",
    );
  });

  test("logs a scratch directory picker failure and preserves the entered path", async () => {
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => undefined);
    console.error = consoleErrorMock as typeof console.error;

    try {
      openDialogMock.mockRejectedValue(new Error("picker failed"));
      renderDialog();
      selectScratchTab();
      fireEvent.change(screen.getByLabelText(/Project path/i), {
        target: { value: "/Users/alice/new-project" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Choose an empty project folder" }));

      await waitFor(() => expect(consoleErrorMock).toHaveBeenCalledWith(
        "Failed to open directory picker:",
        expect.any(Error),
      ));
      expect((screen.getByLabelText(/Project path/i) as HTMLInputElement).value).toBe(
        "/Users/alice/new-project",
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("submits a trimmed scratch path and resets to the existing tab", async () => {
    const onCreate = mock(async () => undefined);
    const onOpenChange = mock(() => undefined);
    renderDialog({ onCreate, onOpenChange });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "  /Users/alice/new-project  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("/Users/alice/new-project"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("tab", { name: "Existing repository" }).getAttribute("data-state"))
      .toBe("active");
    expect((screen.getByLabelText(/Git URL/i) as HTMLInputElement).value).toBe("");
  });

  test("clears errors when switching source tabs", async () => {
    renderDialog({
      onCreate: mock(async () => {
        throw new Error("creation failed");
      }),
    });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "/Users/alice/new-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toContain("creation failed");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Existing repository" }), { button: 0 });

    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("clears a scratch creation error when the project path changes", async () => {
    renderDialog({
      onCreate: mock(async () => {
        throw new Error("creation failed");
      }),
    });
    selectScratchTab();
    const pathInput = screen.getByLabelText(/Project path/i);
    fireEvent.change(pathInput, { target: { value: "/Users/alice/new-project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.change(pathInput, { target: { value: "/Users/alice/another-project" } });

    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("shows a generic message for a non-Error scratch creation failure", async () => {
    const onCreate = mock(async () => {
      throw "failed";
    });
    const onOpenChange = mock(() => undefined);
    renderDialog({ onCreate, onOpenChange });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "/Users/alice/new-project" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Failed to create project");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("does not create a project from a whitespace-only scratch path", async () => {
    const onCreate = mock(async () => undefined);
    renderDialog({ onCreate });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "   " },
    });
    const submitButton = screen.getByRole("button", { name: "Create project" });

    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submitButton.closest("form")!);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Project path is required",
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("ignores duplicate scratch submissions while creation is pending", async () => {
    let resolveCreation!: () => void;
    const onCreate = mock(() => new Promise<void>((resolve) => {
      resolveCreation = resolve;
    }));
    const onOpenChange = mock(() => undefined);
    renderDialog({ onCreate, onOpenChange });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "/Users/alice/new-project" },
    });
    const submitButton = screen.getByRole("button", { name: "Create project" });
    const form = submitButton.closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveCreation());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("ignores duplicate existing-project submissions while the add is pending", async () => {
    let resolveAdd!: () => void;
    const onAdd = mock(() => new Promise<void>((resolve) => {
      resolveAdd = resolve;
    }));
    const onOpenChange = mock(() => undefined);
    renderDialog({ onAdd, onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/i), {
      target: { value: "https://github.com/acme/project.git" },
    });
    const submitButton = screen.getByRole("button", { name: "Add project" });
    const form = submitButton.closest("form");
    expect(form).not.toBeNull();

    // Submitting the form bypasses the disabled button, so only the in-flight
    // ref stops the second request.
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onAdd).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("disables the scratch inputs and shows progress while creation is pending", async () => {
    let resolveCreation!: () => void;
    const onCreate = mock(() => new Promise<void>((resolve) => {
      resolveCreation = resolve;
    }));
    renderDialog({ onCreate });
    selectScratchTab();
    const pathInput = screen.getByLabelText(/Project path/i);
    fireEvent.change(pathInput, { target: { value: "/Users/alice/new-project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect((pathInput as HTMLInputElement).disabled).toBe(true));
    const browseButton = screen.getByRole("button", { name: "Choose an empty project folder" });
    expect((browseButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveCreation());
    await waitFor(() => expect((pathInput as HTMLInputElement).disabled).toBe(false));
  });

  test("allows a retry after a failed scratch submission", async () => {
    const onCreate = mock(async () => {
      throw new Error("GitHub authentication failed");
    });
    renderDialog({ onCreate });
    selectScratchTab();
    fireEvent.change(screen.getByLabelText(/Project path/i), {
      target: { value: "/Users/alice/new-project" },
    });
    const form = screen.getByRole("button", { name: "Create project" }).closest("form");

    fireEvent.submit(form!);
    expect((await screen.findByRole("alert")).textContent).toContain("GitHub authentication failed");

    // The in-flight guard must clear on failure, or the dialog would be wedged.
    fireEvent.submit(form!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
  });

  test("invalidates pending URL validation when the dialog closes", async () => {
    let resolveValidation!: (valid: boolean) => void;
    const validateGitUrl = mock(() => new Promise<boolean>((resolve) => {
      resolveValidation = resolve;
    }));
    const onOpenChange = mock(() => undefined);
    renderDialog({ validateGitUrl, onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/i), {
      target: { value: "https://github.com/acme/project.git" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveValidation(false));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Git URL/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Enter a valid Git URL (SSH or HTTPS format)") === null).toBe(true);
  });
});

function selectScratchTab() {
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Create new" }), { button: 0 });
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {}) {
  return render(
    <AddProjectDialog
      open
      onOpenChange={() => {}}
      onAdd={async () => {}}
      onCreate={async () => {}}
      validateGitUrl={async () => true}
      {...overrides}
    />
  );
}
