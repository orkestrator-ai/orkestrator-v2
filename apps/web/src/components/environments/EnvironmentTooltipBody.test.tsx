import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { EnvironmentTooltipBody } from "./EnvironmentTooltipBody";

afterEach(cleanup);

test("names the machine the environment is on, with its status", () => {
  render(
    <EnvironmentTooltipBody
      name="feature"
      machine={{ name: "arktech-mini", colorToken: "teal", status: "this window" }}
      details={{ environmentType: "local" }}
    />,
  );
  expect(screen.getByTestId("environment-tooltip-machine").textContent).toBe(
    "On arktech-mini · this window",
  );
  expect(screen.getByText("Local worktree")).toBeTruthy();
});

test("a client that shows no machines leaves the line out", () => {
  render(
    <EnvironmentTooltipBody
      name="feature"
      machine={null}
      details={{ environmentType: "containerized", entryPort: 3000, hostEntryPort: 49152 }}
    />,
  );
  expect(screen.queryByTestId("environment-tooltip-machine") === null).toBe(true);
  expect(screen.getByText("Restricted network")).toBeTruthy();
  // No copy action without a handler: the port is on another machine.
  expect(screen.getByText(/port 49152 on that machine/)).toBeTruthy();
});
