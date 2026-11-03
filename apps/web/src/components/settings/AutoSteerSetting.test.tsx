import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutoSteerSetting } from "./AutoSteerSetting";

afterEach(cleanup);

test("off describes queueing and the switch reports a change", () => {
  const onCheckedChange = mock((_checked: boolean) => {});
  render(<AutoSteerSetting checked={false} onCheckedChange={onCheckedChange} />);
  const toggle = screen.getByRole("switch", { name: "Auto-steer" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/a new message is added to the queue/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});

test("on describes steering the running turn", () => {
  render(<AutoSteerSetting checked onCheckedChange={() => {}} />);
  expect(screen.getByRole("switch", { name: "Auto-steer" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.getByText(/steered into the turn that is running now/)).toBeTruthy();
});
