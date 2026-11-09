import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as backend from "@/lib/backend";
import {
  mockToastError,
  mockToastSuccess,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";
import { StartFailureNotice } from "./StartFailureNotice";
import { TerminalContainerOverlays } from "./TerminalContainerOverlays";

const SSH_UNREACHABLE =
  "Couldn't reach the git remote over SSH (github.com, port 22). Your network may be blocking SSH. Retry on a network that allows it, or switch this project's remote to HTTPS.";

beforeEach(() => {
  resetSonnerMocks();
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("shows the failure and offers nothing without a remedy", () => {
  render(
    <StartFailureNotice
      message={SSH_UNREACHABLE}
      remedy={null}
      projectId="p1"
      onRetry={() => {}}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("port 22");
  expect(screen.queryByRole("button", { name: /use https/i }) === null).toBe(true);
});

test("switches the project to HTTPS and retries the start", async () => {
  const switchRemote = spyOn(backend, "switchProjectRemoteToHttps").mockResolvedValue({
    remoteUrl: "https://github.com/acme/widget.git",
    changed: true,
  });
  const retry = mock(() => {});
  render(
    <StartFailureNotice
      message={SSH_UNREACHABLE}
      remedy="use-https"
      projectId="p1"
      onRetry={retry}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Use HTTPS for this project" }));

  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  expect(switchRemote).toHaveBeenCalledWith("p1");
  expect(mockToastSuccess).toHaveBeenCalled();
});

test("a refused switch is reported and does not retry", async () => {
  spyOn(backend, "switchProjectRemoteToHttps").mockRejectedValue(
    new Error("Git has no HTTPS credentials for github.com."),
  );
  const retry = mock(() => {});
  render(
    <StartFailureNotice
      message={SSH_UNREACHABLE}
      remedy="use-https"
      projectId="p1"
      onRetry={retry}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Use HTTPS for this project" }));

  await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  expect(retry).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Use HTTPS for this project" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("the not-started overlay keeps the start failure visible beside Start", () => {
  render(
    <TerminalContainerOverlays
      environmentId="env-1"
      containerId={null}
      isLocalEnvironment
      isEnvironmentRunning={false}
      showNoEnvironmentOverlay={false}
      showCreatingOverlay={false}
      showNotRunningOverlay
      lifecycleError={SSH_UNREACHABLE}
      lifecycleRemedy="use-https"
      projectId="p1"
      setupPhase="pending"
      createScriptPrompt=""
      onStartContainer={() => {}}
      onStartOverlayClick={() => {}}
    />,
  );
  expect(screen.getByText("Environment not started")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("github.com, port 22");
  expect(screen.getByRole("button", { name: "Use HTTPS for this project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /start environment/i })).toBeTruthy();
});

test("the overlay shows no notice for an environment that has not failed", () => {
  render(
    <TerminalContainerOverlays
      environmentId="env-1"
      containerId={null}
      isLocalEnvironment
      isEnvironmentRunning={false}
      showNoEnvironmentOverlay={false}
      showCreatingOverlay={false}
      showNotRunningOverlay
      setupPhase="pending"
      createScriptPrompt=""
      onStartContainer={() => {}}
      onStartOverlayClick={() => {}}
    />,
  );
  expect(screen.queryByRole("alert") === null).toBe(true);
});
