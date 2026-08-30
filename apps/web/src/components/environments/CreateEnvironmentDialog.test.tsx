import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MODAL_MODEL_PICKER_TRIGGER_CLASS_NAME } from "@/components/ui/modal-theme";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";

afterEach(cleanup);

/**
 * Every class the shared picker theme promises must survive `cn`'s tailwind-merge
 * against `AgentModelPicker`'s own base classes, so asserting the constant token by
 * token is what stops one call site drifting from the other.
 */
function expectModelPickerTheme(picker: HTMLElement): void {
  const applied = picker.className.split(/\s+/);
  for (const token of MODAL_MODEL_PICKER_TRIGGER_CLASS_NAME.split(/\s+/)) {
    expect(applied).toContain(token);
  }
}

describe("CreateEnvironmentDialog initial prompt attachments", () => {
  test("uses the compact themed layout with equally sized name and agent controls", () => {
    render(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
          projectName="orkestrator-v2"
        />
      </DockerAvailabilityProvider>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Create Ork (Environment) - orkestrator-v2",
      }),
    ).toBeTruthy();
    expect(screen.getByText("orkestrator-v2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Containerized environment" })).toBeTruthy();

    const containerTypeButton = screen.getByRole("button", { name: "Containerized" });
    const localTypeButton = screen.getByRole("button", { name: "Local" });
    expect(containerTypeButton.className).toContain("font-bold");
    expect(localTypeButton.className).toContain("font-normal");
    expect(localTypeButton.className).toContain("h-8");
    fireEvent.click(localTypeButton);
    expect(screen.getByRole("img", { name: "Local environment" })).toBeTruthy();
    expect(localTypeButton.className).toContain("font-bold");
    expect(containerTypeButton.className).toContain("font-normal");

    expect(screen.getByRole("button", { name: "With a prompt" }).className).toContain("font-bold");
    expect(screen.getByRole("button", { name: "A feature" }).className).toContain("font-normal");
    expect(screen.getByRole("button", { name: "Create Environment" }).className).toContain(
      "font-bold",
    );

    const name = screen.getByLabelText("Environment Name (optional)");
    const agent = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    const launch = screen.getByRole("checkbox", { name: "Launch Agent" });
    expect(name.className).toContain("h-9");
    expect(name.className).toContain("px-3");
    expect(name.className).toContain("bg-input-surface");
    expectModelPickerTheme(agent);
    expect(agent.parentElement).toBe(launch.parentElement?.parentElement ?? null);
    expect(agent.parentElement?.className).toContain("sm:grid-cols-[minmax(0,1fr)_7rem]");
    expect(name.parentElement?.className).toContain("sm:grid-cols-[minmax(0,1fr)_7rem]");
    expect(name.closest("div.border-b")?.className).toContain(
      "sm:grid-cols-[7.5rem_minmax(0,1fr)]",
    );
    expect(name.closest("div.border-b")?.className).toContain("sm:px-6");
    expect(name.closest("div.border-b")?.className).toContain("py-3");
    expect(agent.closest("div.border-b")?.className).toContain(
      "sm:grid-cols-[7.5rem_minmax(0,1fr)]",
    );

    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    const header = document.querySelector<HTMLElement>('[data-slot="dialog-header"]');
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("sm:max-w-[896px]");
    expect(dialog.className).toContain("bg-background");
    expect(dialog.className).toContain("sm:p-0");
    expect(dialog.style.getPropertyValue("--color-background")).toBe("");
    expect(header?.className).toContain("bg-background");
    expect(overlay?.className).toContain("bg-black/75");
    expect(overlay?.className).toContain("backdrop-blur-md");
  });

  test("keeps disabled environment-type explanations visible and associated", () => {
    render(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
          localEnvironmentAvailable={false}
        />
      </DockerAvailabilityProvider>,
    );

    const containerized = screen.getByRole("button", { name: "Containerized" });
    const local = screen.getByRole("button", { name: "Local" });
    expect(containerized.getAttribute("aria-describedby")).toBe("containerized-unavailable");
    expect(local.getAttribute("aria-describedby")).toBe("local-unavailable");
    expect(screen.getByText("Unavailable while Docker is stopped")).toBeTruthy();
    expect(screen.getByText("Unavailable without a local project checkout")).toBeTruthy();
  });

  test("themes customized build model selectors like the dialog agent selector", () => {
    render(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={mock(async () => true)}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "A feature" }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Customize models" }));

    const customization = screen.getByRole("group", {
      name: "Feature build model customization",
    });
    // Match on the label rather than the combobox role: the picker only takes
    // that role when it is given an id, so a picker added without one would
    // silently drop out of a role-based query instead of failing the theme
    // assertions below.
    const customizedPickers = within(customization).getAllByLabelText(
      /agent, model and reasoning$/,
    );
    const labels = customizedPickers.map((picker) => picker.getAttribute("aria-label"));

    // The first step row, the reviewer rows, and the step rows rendered after
    // the reviewer block are three separate render paths in FeatureBuildFields.
    expect(labels).toContain("Build agent, model and reasoning");
    expect(labels).toContain("Review 1 agent, model and reasoning");
    expect(labels).toContain("Review 2 agent, model and reasoning");
    expect(labels).toContain("Resolve conflicts agent, model and reasoning");
    expect(within(customization).getAllByRole("combobox").length).toBe(customizedPickers.length);

    for (const picker of customizedPickers) {
      expectModelPickerTheme(picker);
    }
  });

  test("attaches a dropped markdown file and includes it in the create request", async () => {
    const onCreate = mock(async (_options: ClaudeOptions) => true);
    render(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          onOpenChange={mock(() => undefined)}
          onCreate={onCreate}
          projectId="project-1"
        />
      </DockerAvailabilityProvider>,
    );

    const dialog = screen.getByRole("dialog");
    const file = new File(["# Requirements\n\nShip the drag-and-drop flow."], "requirements.md", {
      type: "text/markdown",
    });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      dropEffect: "copy",
    };

    fireEvent.dragEnter(dialog, { dataTransfer });
    expect(screen.getByText("Drop files to attach them to the initial prompt")).toBeTruthy();
    fireEvent.drop(dialog, { dataTransfer });

    await screen.findByText("requirements.md");
    fireEvent.change(screen.getByLabelText(/Initial Prompt/), {
      target: { value: "Implement the attached requirements." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        initialPrompt: "Implement the attached requirements.",
        initialPromptAttachments: [
          expect.objectContaining({
            name: "requirements.md",
            type: "file",
            base64Data: btoa("# Requirements\n\nShip the drag-and-drop flow."),
          }),
        ],
      }),
    );
  });
});
