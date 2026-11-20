import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  BuildPipelineKeyInformation,
  KeyInformationVerification,
} from "@orkestrator/protocol/build-pipeline-key-information";
import { KeyInformationBody } from "./PipelineKeyInformation";
import { VerificationRounds } from "./key-information-tab-sections";
import { keyInformation } from "./key-information-test-fixture";

/**
 * A verification check the stage could not run is recorded as `not-checked`
 * and shown apart from a failure in both the header panel and the full tab.
 * A record written before `status` existed still reads from `passed`.
 */

const verification: KeyInformationVerification = {
  round: 0,
  passed: true,
  summary: "Everything that could be checked here passed.",
  checks: [
    { check: "Unit tests pass", passed: true, status: "passed" },
    {
      check: "Sign-in works against the live provider",
      passed: false,
      status: "not-checked",
      details: "Needs a provider account.",
    },
    { check: "Lint is clean", passed: false, status: "failed", details: "Two findings." },
    { check: "Legacy record failure", passed: false },
  ],
};

function checkRow(container: HTMLElement, text: string): HTMLElement {
  return within(container).getByText(text).closest("li") as HTMLElement;
}

function expectStatuses(container: HTMLElement) {
  const passed = checkRow(container, "Unit tests pass");
  expect(within(passed).getByLabelText("Passed")).toBeTruthy();

  const notChecked = checkRow(container, "Sign-in works against the live provider");
  expect(within(notChecked).getByLabelText("Not checked")).toBeTruthy();
  expect(within(notChecked).queryByLabelText("Failed") === null).toBe(true);
  expect(within(notChecked).getByText(/Not checked/, { selector: "span" })).toBeTruthy();
  expect(within(notChecked).getByText("Needs a provider account.")).toBeTruthy();

  expect(within(checkRow(container, "Lint is clean")).getByLabelText("Failed")).toBeTruthy();
  expect(
    within(checkRow(container, "Legacy record failure")).getByLabelText("Failed"),
  ).toBeTruthy();
}

afterEach(cleanup);

describe("verification check status", () => {
  test("the full tab shows a not-checked check apart from a failure", () => {
    const { container } = render(<VerificationRounds verifications={[verification]} />);
    expectStatuses(container);
  });

  test("the header panel shows a not-checked check apart from a failure", () => {
    const info: BuildPipelineKeyInformation = { ...keyInformation, verifications: [verification] };
    render(<KeyInformationBody keyInformation={info} />);
    expectStatuses(screen.getByTestId("pipeline-key-information-scroller"));
  });
});
