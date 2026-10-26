import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as realBackend from "@/lib/backend";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";

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
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
    expect(screen.queryByLabelText("Input for the running command")).toBeNull();
    expect(screen.getByText("npm ERR!")).toBeTruthy();
  });
});
