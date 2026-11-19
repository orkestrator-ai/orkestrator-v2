import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LaunchBaseRow } from "./LaunchBaseRow";

afterEach(cleanup);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-11-19T10:05:00.000Z");

describe("LaunchBaseRow", () => {
  test("renders nothing when no base is wanted", () => {
    const { container } = render(<LaunchBaseRow state={{ status: "idle" }} onRefresh={() => {}} />);
    expect(container.textContent).toBe("");
  });

  test("says the base is being refreshed", () => {
    render(<LaunchBaseRow state={{ status: "resolving" }} onRefresh={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Refreshing the base branch");
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });

  test("shows the whole commit and when it was fetched", () => {
    render(
      <LaunchBaseRow
        state={{
          status: "ready",
          freshness: "fresh",
          branch: "main",
          ref: "origin/main",
          commit: COMMIT,
          fetchedAt: "2026-11-19T10:04:30.000Z",
        }}
        onRefresh={() => {}}
        now={NOW}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("origin/main");
    expect(status.textContent).toContain(COMMIT);
    expect(status.textContent).toContain("fetched just now");
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });

  test("labels a last-fetched commit and offers to retry", () => {
    const onRefresh = mock(() => {});
    render(
      <LaunchBaseRow
        state={{
          status: "ready",
          freshness: "last-fetched",
          branch: "main",
          ref: "origin/main",
          commit: COMMIT,
          fetchedAt: "2026-11-19T08:05:00.000Z",
          fetchError: "Could not resolve host",
        }}
        onRefresh={onRefresh}
        now={NOW}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "last fetched 2h ago; the remote could not be refreshed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("names a local-only base and an unavailable one", () => {
    render(
      <LaunchBaseRow
        state={{ status: "ready", freshness: "local", branch: "main", ref: "main", commit: COMMIT }}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("local branch, no remote");
    cleanup();

    render(
      <LaunchBaseRow
        state={{ status: "unavailable", reason: "Base branch nowhere was not found" }}
        onRefresh={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Base branch nowhere was not found");
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
