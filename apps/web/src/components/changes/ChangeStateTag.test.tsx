import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { environmentProjectionFixture } from "../files-panel/change-projection-test-fixture";
import { ChangeStateTag } from "./ChangeStateTag";
afterEach(cleanup);
for (const state of ["ready", "partial"] as const)
  test(`${state} interrupted projections stay Interrupted until settlement`, () => {
    const projection = environmentProjectionFixture("env", {
      state,
      reasonKeys: ["changes.reason.interrupted"],
    });
    const view = render(<ChangeStateTag projection={projection} />);
    expect(screen.getByTestId("change-state-tag").textContent).toBe("Interrupted");
    view.rerender(<ChangeStateTag projection={{ ...projection, reasonKeys: [] }} />);
    expect(screen.getByTestId("change-state-tag").textContent).toBe("Final");
  });
