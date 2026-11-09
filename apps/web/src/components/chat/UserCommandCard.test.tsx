import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as realBackend from "@/lib/backend";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { UserCommandService } from "../../../../backend/src/core/user-commands";
import { HumanPromptRegistry } from "../../../../backend/src/core/human-prompt-registry";
import {
  USER_COMMAND_OUTPUT_TAIL_CHARS,
  type UserCommandRecord,
} from "@orkestrator/protocol/user-commands";

const realBackendSnapshot = { ...realBackend };
const writeMock = mock(async (_id: string, _text: string) => ({}) as UserCommandRecord);
const cancelMock = mock(async (_id: string) => ({}) as UserCommandRecord);
const openMock = mock(async (_url: string) => {});
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  writeUserCommandInput: writeMock,
  cancelUserCommand: cancelMock,
  openInBrowser: openMock,
}));

const { UserCommandCard } = await import("./UserCommandCard");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});
afterEach(() => {
  cleanup();
  writeMock.mockClear();
  cancelMock.mockClear();
  openMock.mockClear();
});

const URL = "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967";

function record(overrides: Partial<UserCommandRecord> = {}): UserCommandRecord {
  return {
    id: "cmd-1",
    environmentId: "env-1",
    tabId: "tab-1",
    command: "npm login --auth-type=web",
    target: "worktree",
    cwd: "/work",
    status: "running",
    startedAt: "2026-10-26T13:51:47.000Z",
    output: `Login at:\n${URL}\nPress ENTER to open in the browser...`,
    outputTruncated: false,
    prompt: { kind: "sign-in", url: URL, wantsEnter: true, text: `Login at: ${URL}`, key: "k" },
    context: { state: "pending" },
    revision: 3,
    ...overrides,
  };
}

describe("UserCommandCard", () => {
  test("a waiting sign-in shows the link, ENTER, input and cancel", async () => {
    render(<UserCommandCard command={record()} />);
    expect(screen.getByText("Sign in to continue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open link/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalledWith(URL));
    fireEvent.click(screen.getByRole("button", { name: /Press ENTER/ }));
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith("cmd-1", ""));
    fireEvent.change(screen.getByLabelText("Input for the running command"), {
      target: { value: "yes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith("cmd-1", "yes"));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("cmd-1"));
  });

  test("a password prompt takes masked input", () => {
    render(
      <UserCommandCard
        command={record({
          command: "sudo true",
          output: "[sudo] password for me: ",
          prompt: { kind: "secret", wantsEnter: false, text: "[sudo] password for me:", key: "s" },
        })}
      />,
    );
    expect(screen.getByText("Waiting for a password or passphrase")).toBeTruthy();
    expect((screen.getByLabelText("Input for the running command") as HTMLInputElement).type).toBe(
      "password",
    );
  });

  test("a finished command shows its exit code and no controls", () => {
    render(
      <UserCommandCard
        command={record({ status: "exited", exitCode: 1, prompt: undefined, output: "npm ERR!" })}
      />,
    );
    expect(screen.getByText("Exit 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cancel/ }) === null).toBe(true);
    expect(screen.queryByLabelText("Input for the running command") === null).toBe(true);
    expect(screen.getByText("npm ERR!")).toBeTruthy();
  });

  test("backend snapshots flow into the card as the PTY spinner redraws", async () => {
    // Feed the real backend service through its PTY boundary, then pass its
    // serialized records directly into the card, without normalizing in here.
    let emit = (_text: string) => {};
    const service = new UserCommandService({
      prompts: new HumanPromptRegistry(),
      announce() {},
      resolve: async () => ({
        target: "worktree",
        cwd: "/work",
        spawn: () => ({
          pid: fakePid(42),
          write() {},
          resize() {},
          kill() {},
          terminate: async () => true,
          onData(callback) {
            emit = callback;
            return { dispose() {} };
          },
          onExit() {
            return { dispose() {} };
          },
        }),
      }),
    });
    try {
      const started = await service.run({
        environmentId: "env-1",
        tabId: "tab-1",
        command: "npm login",
      });
      const E = "\u001b";
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"];
      const chunks = [`npm notice Log in on https://registry.npmjs.org/\r\n${E}[?25l`];
      for (const frame of frames) chunks.push(`${E}[1`, `G${E}[0K${frame}`);
      const at = (): UserCommandRecord => JSON.parse(JSON.stringify(service.get(started.id)));
      const view = render(<UserCommandCard command={at()} />);
      const output = () => view.container.querySelector("pre")?.textContent ?? "";
      for (const chunk of chunks) {
        emit(chunk);
        view.rerender(<UserCommandCard command={at()} />);
        const frame = /[⠋⠙⠹⠸⠼⠴]/gu;
        // Never more than one frame on screen, and always the latest one.
        expect((output().match(frame) ?? []).length).toBeLessThanOrEqual(1);
      }
      expect(output()).toBe("npm notice Log in on https://registry.npmjs.org/\n⠴");
      emit(`${E}[1G${E}[0KLogin at:\r\n`);
      view.rerender(<UserCommandCard command={at()} />);
      expect(output()).toBe("npm notice Log in on https://registry.npmjs.org/\nLogin at:\n");
      emit(`${URL}\r\nPress ENTER to open in the browser...`);
      view.rerender(<UserCommandCard command={at()} />);
      expect(screen.getByRole("button", { name: /Open link/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Press ENTER/ })).toBeTruthy();

      emit("x\n".repeat(32000) + `${E}[4096CX`);
      view.rerender(<UserCommandCard command={at()} />);
      const truncated = at();
      expect(truncated.output.length).toBe(USER_COMMAND_OUTPUT_TAIL_CHARS);
      expect(output()).toBe(`[earlier output omitted]\n${truncated.output}`);
      expect(screen.getByText(/\[earlier output omitted\]/)).toBeTruthy();
    } finally {
      await service.shutdown();
    }
  });

  test("truncated output keeps the omitted-output marker", () => {
    render(
      <UserCommandCard
        command={record({ output: "last lines\n", outputTruncated: true, prompt: undefined })}
      />,
    );
    expect(screen.getByText(/\[earlier output omitted\]/)).toBeTruthy();
    expect(screen.getByText(/last lines/)).toBeTruthy();
  });
});
