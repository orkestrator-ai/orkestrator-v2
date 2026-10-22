import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { NodeSshPromptDialog } from "./NodeSshPromptDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

test("pending SSH prompts rehydrate and overlapping prompts retain isolated answers", async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const listenMock = listen as unknown as ReturnType<typeof mock>;
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  );
  const a = {
    promptId: "a",
    nodeId: "bk_a",
    kind: "password",
    message: "Password A",
    state: "open",
  };
  const b = {
    promptId: "b",
    nodeId: "bk_b",
    kind: "password",
    message: "Password B",
    state: "open",
  };
  let pending = [a];
  const answers: unknown[] = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_node_ssh_prompts") return pending;
    if (command === "answer_node_ssh_prompt") {
      answers.push(args);
      pending = pending.filter((entry) => entry.promptId !== args.promptId);
      return { answered: true };
    }
  });
  const mounted = render(<NodeSshPromptDialog />);
  await screen.findByText(/SSH needs your answer.*bk_a/);
  fireEvent.change(screen.getByLabelText("SSH answer"), { target: { value: "secret-a" } });
  pending = [a, b];
  await act(async () => handlers.get("node-ssh-prompt")?.({ payload: b }));
  expect(
    screen.getByLabelText("SSH answer").getAttribute("value") ??
      (screen.getByLabelText("SSH answer") as HTMLInputElement).value,
  ).toBe("secret-a");
  // Closing A changes the displayed prompt; its typed secret cannot reach B.
  await act(async () => handlers.get("node-ssh-prompt")?.({ payload: { ...a, state: "closed" } }));
  await screen.findByText(/SSH needs your answer.*bk_b/);
  expect((screen.getByLabelText("SSH answer") as HTMLInputElement).value).toBe("");
  expect(answers).toEqual([]);
  mounted.unmount();
  pending = [a];
  render(<NodeSshPromptDialog />);
  await screen.findByText(/SSH needs your answer.*bk_a/);
  pending = [b];
  await act(async () => handlers.get("native-event-stream-connected")?.({ payload: undefined }));
  await screen.findByText(/SSH needs your answer.*bk_b/);
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});
