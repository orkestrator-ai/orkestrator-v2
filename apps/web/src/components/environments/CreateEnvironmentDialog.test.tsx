import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";

afterEach(cleanup);

describe("CreateEnvironmentDialog initial prompt attachments", () => {
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
