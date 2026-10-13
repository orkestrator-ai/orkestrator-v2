import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { rowlessBackgroundTaskMessages } from "@/lib/chat/native-message-adapters";
import { NativeMessage } from "./NativeMessage";
import { BackgroundTaskCard } from "./NativeMessage.agent-parts";

afterEach(cleanup);

describe("background task agent role", () => {
  test("a rowless task names its agent when the snapshot has no description", () => {
    const [row] = rowlessBackgroundTaskMessages(
      [{ id: "agent-1", status: "running", agentRole: "Explore" }],
      [],
    );

    render(<NativeMessage message={row!} />);

    expect(screen.getByRole("button", { name: /Agent Explore Running/ })).toBeTruthy();
    expect(screen.queryByText("Background task agent-1")).toBeNull();
  });

  test("a backgrounded main session is not presented as a delegated agent", () => {
    render(
      <BackgroundTaskCard
        task={{ id: "main-1", status: "running", agentRole: "main-session" }}
        open={false}
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Main session Backgrounded conversation Running/ }),
    ).toBeTruthy();
    expect(screen.queryByText("main-session")).toBeNull();
  });

  test("a described agent keeps its description and shows its type in the details", () => {
    render(
      <BackgroundTaskCard
        task={{
          id: "agent-2",
          status: "completed",
          description: "Survey the adapters",
          agentRole: "general-purpose",
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Agent Survey the adapters Completed/ }),
    ).toBeTruthy();
    expect(screen.getByText("Agent type")).toBeTruthy();
    expect(screen.getByText("general-purpose")).toBeTruthy();
  });

  test("a task with no role still reads as a task", () => {
    render(
      <BackgroundTaskCard
        task={{ id: "shell-1", status: "running", description: "Watch the build" }}
        open={false}
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Task Watch the build Running/ })).toBeTruthy();
  });
});
