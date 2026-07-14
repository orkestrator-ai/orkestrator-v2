import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as realBackend from "@/lib/backend";
import * as realNativeDialog from "@/lib/native/dialog";

const realBackendSnapshot = { ...realBackend };
const realNativeDialogSnapshot = { ...realNativeDialog };
const openDialogMock = mock(async (): Promise<string | null> => null);
const getGitRemoteUrlMock = mock(async (): Promise<string | null> => null);

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
    openDialogMock.mockReset();
    openDialogMock.mockResolvedValue(null);
    getGitRemoteUrlMock.mockReset();
    getGitRemoteUrlMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
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
});
