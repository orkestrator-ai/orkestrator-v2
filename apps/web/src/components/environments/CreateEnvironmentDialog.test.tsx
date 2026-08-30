import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";

afterEach(cleanup);

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
    expect(screen.getByRole("button", { name: "Cancel" }).dataset.variant).toBe("outline");

    const name = screen.getByLabelText("Environment Name (optional)");
    const agent = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    const launch = screen.getByRole("checkbox", { name: "Launch Agent" });
    expect(name.className).toContain("h-9");
    expect(name.className).toContain("px-3");
    expect(name.className).toContain("bg-input-surface");
    expect(agent.className).toContain("h-9");
    expect(agent.className).toContain("w-full");
    expect(agent.className).toContain("bg-input-surface");
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
