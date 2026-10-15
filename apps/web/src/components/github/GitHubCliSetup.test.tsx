import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GitHubCliLoginProgress, GitHubCliStatus } from "@/lib/backend";

const calls: string[] = [];
let status: GitHubCliStatus;
let login: GitHubCliLoginProgress;
let loginResult: GitHubCliLoginProgress;
/** Applied by the next sign-in poll: the backend finishing its work. */
let onNextPoll: (() => void) | undefined;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string) => {
    calls.push(command);
    switch (command) {
      case "get_github_cli_status":
        return Promise.resolve(status);
      case "get_github_cli_login": {
        const finish = onNextPoll;
        onNextPoll = undefined;
        finish?.();
        return Promise.resolve(login);
      }
      case "start_github_cli_login":
        login = loginResult;
        return Promise.resolve(login);
      case "set_github_cli_reminder_dismissed":
        status = { ...status, reminderDismissed: false };
        return Promise.resolve({ global: {} });
      case "cancel_github_cli_login":
        login = { state: "idle" };
        return Promise.resolve(login);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

mock.module("@/lib/native/clipboard", () => ({ writeText: mock(async () => undefined) }));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { GitHubCliSetup } = await import("./GitHubCliSetup");

const SIGNED_OUT: GitHubCliStatus = {
  installed: true,
  authenticated: false,
  canSignIn: true,
  reminderDismissed: false,
};

function renderSetup(onStatusChange?: (status: GitHubCliStatus) => void) {
  return render(<GitHubCliSetup pollIntervalMs={5} onStatusChange={onStatusChange} />);
}

async function startSignIn() {
  const signIn = await screen.findByRole("button", { name: "Sign in to GitHub" });
  act(() => signIn.click());
  await screen.findByText("A1B2-C3D4");
}

describe("GitHubCliSetup", () => {
  beforeEach(() => {
    calls.length = 0;
    status = SIGNED_OUT;
    login = { state: "idle" };
    loginResult = {
      state: "pending",
      operationId: "login-1",
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    };
    onNextPoll = undefined;
  });

  afterEach(() => cleanup());

  test("signs in with the device code and reports the signed-in state", async () => {
    const statuses: GitHubCliStatus[] = [];
    renderSetup((next) => statuses.push(next));

    await startSignIn();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeTruthy();
    expect(screen.getByText("Waiting for you to approve the sign-in…")).toBeTruthy();

    onNextPoll = () => {
      login = { state: "succeeded", operationId: "login-1" };
      status = { installed: true, authenticated: true, canSignIn: true, reminderDismissed: false };
    };
    expect(await screen.findByText("The GitHub CLI is installed and signed in.")).toBeTruthy();
    expect(statuses.at(-1)).toEqual(status);
  });

  test("cancels a pending sign-in", async () => {
    renderSetup();

    await startSignIn();
    act(() => screen.getByRole("button", { name: "Cancel sign-in" }).click());

    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
    expect(calls).toContain("cancel_github_cli_login");
  });

  test("reports a failed sign-in and offers it again", async () => {
    renderSetup();

    await startSignIn();
    onNextPoll = () => {
      login = {
        state: "failed",
        operationId: "login-1",
        error: "The sign-in did not complete (exit code 1)",
      };
    };

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("did not complete"),
    );
    expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  test("resumes a sign-in that was already running", async () => {
    login = loginResult;
    renderSetup();

    expect(await screen.findByText("A1B2-C3D4")).toBeTruthy();
    expect(calls).not.toContain("start_github_cli_login");
  });

  test("shows install commands when no gh is available, then finds one", async () => {
    status = { installed: false, authenticated: false, canSignIn: false, reminderDismissed: false };
    renderSetup();

    expect(await screen.findByText("winget install GitHub.cli")).toBeTruthy();

    status = SIGNED_OUT;
    act(() => screen.getByRole("button", { name: "Check again" }).click());
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  test("turns a dismissed startup reminder back on", async () => {
    status = { ...SIGNED_OUT, reminderDismissed: true };
    renderSetup();

    const restore = await screen.findByRole("button", { name: "Remind me at startup" });
    act(() => restore.click());

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remind me at startup" }) === null).toBe(true),
    );
    expect(calls).toContain("set_github_cli_reminder_dismissed");
  });

  test("does not offer sign-in where the backend refuses it", async () => {
    status = { installed: true, authenticated: false, canSignIn: false, reminderDismissed: false };
    renderSetup();

    expect(await screen.findByText(/this profile cannot sign it in/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in to GitHub" }) === null).toBe(true);
  });
});
