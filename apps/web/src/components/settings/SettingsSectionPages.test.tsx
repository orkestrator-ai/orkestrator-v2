import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as backend from "@/lib/backend";
import { EnvironmentSettingsDialog } from "@/components/environments/EnvironmentSettingsDialog";
import { RepositorySettings } from "./RepositorySettings";
import { configStore } from "@/stores/configStore";
import { COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL } from "@orkestrator/protocol/coordinator";
import type { Environment, Project } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

const project: Project = {
  id: "layout-project",
  name: "Layout project",
  gitUrl: "",
  localPath: "/fixture/project",
  order: 0,
  addedAt: "2026-10-31T00:00:00.000Z",
};
const environment: Environment = {
  id: "layout-environment",
  projectId: project.id,
  name: "Layout environment",
  environmentType: "local",
  status: "running",
  setupPhase: "ready",
  order: 0,
  hasMergeConflicts: null,
  networkAccessMode: "restricted",
  branch: "main",
  containerId: null,
  prUrl: null,
  prState: null,
  createdAt: "2026-10-31T00:00:00.000Z",
};

beforeEach(() => {
  // Layout is available while the backend loads; leave those unrelated requests pending.
  spyOn(backend, "getAgentModelCatalogCache").mockImplementation(() => new Promise(() => {}));
  spyOn(backend, "getEnvironmentExtensions").mockImplementation(() => new Promise(() => {}));
  spyOn(backend, "getEnvironmentDiskUsage").mockImplementation(() => new Promise(() => {}));
  spyOn(backend, "getPreviewCapabilities").mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  mock.restore();
});

function expectPage(title: string, width: "default" | "wide") {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  const page = heading.closest("header")!.parentElement!;
  expect(page.classList.contains(width === "wide" ? "max-w-5xl" : "max-w-3xl")).toBe(true);
  expect(page.classList.contains("mx-auto")).toBe(false);
  return page;
}

for (const [section, title, width] of [
  ["general", "General", "default"],
  ["defaults", "Defaults", "wide"],
  ["extensions", "Extensions", "wide"],
  ["previews", "Preview services", "default"],
] as const) {
  test(`environment ${section} uses its menu title and ${width} page width`, () => {
    render(
      <EnvironmentSettingsDialog
        open
        onOpenChange={() => {}}
        environment={environment}
        onUpdate={() => {}}
        initialSection={section}
      />,
    );
    expectPage(title, width);
  });
}

test("repository section navigation uses menu titles and widens Defaults only", () => {
  render(<RepositorySettings project={project} open onOpenChange={() => {}} />);
  expectPage("General", "default");
  fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
  expectPage("Defaults", "wide");
  fireEvent.click(screen.getByRole("button", { name: "Branches" }));
  expectPage("Branches", "default");
});

for (const stored of [undefined, true]) {
  test(`repository coordinator form loads ${stored ?? "default off"} and saves the edited switch`, async () => {
    const original = appCommandStore(configStore).getState().config;
    const config = {
      ...original,
      repositories: {
        ...original.repositories,
        [project.id]: {
          defaultBranch: "main",
          prBaseBranch: "main",
          ...(stored ? { coordinatorOtherEnvironments: true } : {}),
        },
      },
    };
    appCommandStore(configStore).setState({ config });
    const save = spyOn(backend, "patchRepositorySettings").mockResolvedValue(config);
    const close = mock(() => {});
    try {
      render(<RepositorySettings project={project} open onOpenChange={close} />);
      fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
      const control = screen.getByRole("switch", {
        name: COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL,
      });
      expect(control.getAttribute("aria-checked")).toBe(String(stored === true));
      fireEvent.click(control);
      expect(control.getAttribute("aria-checked")).toBe(String(stored !== true));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0]![0]).toBe(project.id);
      expect(save.mock.calls[0]![1]).toEqual(stored ? {} : { coordinatorOtherEnvironments: true });
      expect(save.mock.calls[0]![2]).toEqual(stored ? ["coordinatorOtherEnvironments"] : []);
      await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    } finally {
      appCommandStore(configStore).setState({ config: original });
    }
  });
}
