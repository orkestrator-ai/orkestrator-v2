import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { EnvironmentStartingCommit } from "./EnvironmentStartingCommit";

afterEach(cleanup);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("EnvironmentStartingCommit", () => {
  test.each(["worktreeBaseBranch", "delegationBaseBranch"] as const)(
    "shows the base branch and whole starting commit from %s",
    (branchField) => {
      render(
        <EnvironmentStartingCommit
          environment={{ createdFromCommit: COMMIT, [branchField]: "main" }}
        />,
      );
      const row = screen.getByTestId("environment-starting-commit");
      expect(row.textContent).toContain("Started from");
      expect(row.textContent).toContain("main @");
      expect(row.textContent).toContain(COMMIT);
    },
  );

  test("shows nothing before the checkout exists or for the project home", () => {
    const { container } = render(<EnvironmentStartingCommit environment={{}} />);
    expect(container.textContent).toBe("");
    render(
      <EnvironmentStartingCommit environment={{ createdFromCommit: COMMIT, projectHome: true }} />,
    );
    expect(screen.queryByTestId("environment-starting-commit") === null).toBe(true);
  });
});
