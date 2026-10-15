import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  GitHubCliInstallProgress,
  GitHubCliLoginProgress,
  GitHubCliStatus,
} from "@/lib/backend";

const calls: string[] = [];
let status: GitHubCliStatus;
let install: GitHubCliInstallProgress;
let login: GitHubCliLoginProgress;
let installResult: GitHubCliInstallProgress;
let loginResult: GitHubCliLoginProgress;
/** Applied by the next install or sign-in poll: the backend finishing its work. */
let onNextPoll: (() => void) | undefined;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string) => {
    calls.push(command);
    switch (command) {
      case "get_github_cli_status":
        return Promise.resolve(status);
      case "start_github_cli_install":
        install = installResult;
        return Promise.resolve(install);
      case "get_github_cli_install":
      case "get_github_cli_login": {
        const finish = onNextPoll;
        onNextPoll = undefined;
        finish?.();
        return Promise.resolve(command === "get_github_cli_install" ? install : login);
      }
      case "start_github_cli_login":
        login = loginResult;
        return Promise.resolve(login);
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

function renderSetup(onStatusChange?: (status: GitHubCliStatus) => void) {
  return render(<GitHubCliSetup pollIntervalMs={5} onStatusChange={onStatusChange} />);
}

describe("GitHubCliSetup", () => {
  beforeEach(() => {
    calls.length = 0;
    status = { installed: false, authenticated: false, canInstallWithHomebrew: true };
    install = { state: "idle" };
    login = { state: "idle" };
    installResult = { state: "pending", operationId: "install-1" };
    loginResult = {
      state: "pending",
      operationId: "login-1",
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    };
    onNextPoll = undefined;
  });

  afterEach(() => cleanup());

  test("installs gh with Homebrew, then offers to sign in", async () => {
    const statuses: GitHubCliStatus[] = [];
    renderSetup((next) => statuses.push(next));

    const installButton = await screen.findByRole("button", { name: "Install with Homebrew" });
    // Polls return pending until the backend reports the install finished.
    act(() => installButton.click());
    expect(await screen.findByText("Installing GitHub CLI…")).toBeTruthy();

    onNextPoll = () => {
      install = { state: "succeeded", operationId: "install-1" };
      status = { installed: true, authenticated: false, canInstallWithHomebrew: false };
    };
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
    expect(calls).toContain("start_github_cli_install");
    expect(statuses.at(-1)).toEqual(status);
  });

  test("signs in with the device code and reports the signed-in state", async () => {
    status = { installed: true, authenticated: false, canInstallWithHomebrew: false };
    renderSetup();

    const signIn = await screen.findByRole("button", { name: "Sign in to GitHub" });
    act(() => signIn.click());
    expect(await screen.findByText("A1B2-C3D4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeTruthy();
    expect(screen.getByText("Waiting for you to approve the sign-in…")).toBeTruthy();

    onNextPoll = () => {
      login = { state: "succeeded", operationId: "login-1" };
      status = { installed: true, authenticated: true, canInstallWithHomebrew: false };
    };
    expect(await screen.findByText("The GitHub CLI is installed and signed in.")).toBeTruthy();
  });

  test("cancels a pending sign-in", async () => {
    status = { installed: true, authenticated: false, canInstallWithHomebrew: false };
    renderSetup();

    const signIn = await screen.findByRole("button", { name: "Sign in to GitHub" });
    act(() => signIn.click());
    await screen.findByText("A1B2-C3D4");
    act(() => screen.getByRole("button", { name: "Cancel sign-in" }).click());

    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
    expect(calls).toContain("cancel_github_cli_login");
  });

  test("shows install commands where Homebrew cannot be used", async () => {
    status = { installed: false, authenticated: false, canInstallWithHomebrew: false };
    renderSetup();

    expect(await screen.findByText("winget install GitHub.cli")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install with Homebrew" }) === null).toBe(true);

    status = { installed: true, authenticated: false, canInstallWithHomebrew: false };
    act(() => screen.getByRole("button", { name: "Check again" }).click());
    expect(await screen.findByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  test("reports a failed install", async () => {
    renderSetup();

    const installButton = await screen.findByRole("button", { name: "Install with Homebrew" });
    act(() => installButton.click());
    onNextPoll = () => {
      install = {
        state: "failed",
        operationId: "install-1",
        error: "Homebrew could not install the GitHub CLI (exit code 1).",
      };
    };

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Homebrew could not install"),
    );
    expect(screen.getByRole("button", { name: "Install with Homebrew" })).toBeTruthy();
  });

  test("resumes a sign-in that was already running", async () => {
    status = { installed: true, authenticated: false, canInstallWithHomebrew: false };
    login = loginResult;
    renderSetup();

    expect(await screen.findByText("A1B2-C3D4")).toBeTruthy();
    expect(calls).not.toContain("start_github_cli_login");
  });
});
