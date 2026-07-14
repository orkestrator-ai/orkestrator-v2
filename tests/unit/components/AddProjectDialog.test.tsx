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

  test("caps the dialog width at 6xl", () => {
    render(
      <AddProjectDialog
        open
        onOpenChange={() => {}}
        onAdd={async () => {}}
        validateGitUrl={async () => true}
      />
    );

    expect(screen.getByRole("dialog").className).toContain("sm:max-w-6xl");
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
        validateGitUrl={validateGitUrl}
      />
    );

    fireEvent.change(screen.getByLabelText(/Local Path/), {
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
      title: "Select Repository Directory",
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
    expect((screen.getByLabelText(/Local Path/) as HTMLInputElement).value).toBe(
      "/Users/alice/project"
    );
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/project.git"
    );
  });

  test("does not inspect the typed path when the native picker is cancelled", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Local Path/), {
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
    expect(screen.queryByText("Enter a valid Git URL (SSH or HTTPS format)")).toBeNull();
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

  test("submits trimmed values and resets after success", async () => {
    const onAdd = mock(async () => undefined);
    const onOpenChange = mock(() => undefined);
    renderDialog({ onAdd, onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "  https://github.com/acme/project.git  " },
    });
    fireEvent.change(screen.getByLabelText(/Local Path/), {
      target: { value: "  /Users/alice/project  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      "https://github.com/acme/project.git",
      "/Users/alice/project",
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Local Path/) as HTMLInputElement).value).toBe("");
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

    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    expect(await screen.findByText("Failed to add project")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe(
      "https://github.com/acme/project.git"
    );
  });

  test("blocks submission after URL validation reports invalid", async () => {
    const onAdd = mock(async () => undefined);
    renderDialog({ onAdd, validateGitUrl: mock(async () => false) });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "invalid" },
    });
    await screen.findByText("Enter a valid Git URL (SSH or HTTPS format)");

    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    expect(await screen.findByText("Invalid Git URL format")).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("cancel clears the form and reports the close request", async () => {
    const onOpenChange = mock(() => undefined);
    renderDialog({ onOpenChange });
    fireEvent.change(screen.getByLabelText(/Git URL/), {
      target: { value: "https://github.com/acme/project.git" },
    });
    fireEvent.change(screen.getByLabelText(/Local Path/), {
      target: { value: "/Users/alice/project" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Git URL/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Local Path/) as HTMLInputElement).value).toBe("");
  });
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {}) {
  return render(
    <AddProjectDialog
      open
      onOpenChange={() => {}}
      onAdd={async () => {}}
      validateGitUrl={async () => true}
      {...overrides}
    />
  );
}
