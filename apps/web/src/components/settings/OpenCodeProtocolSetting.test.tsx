import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpenCodeProtocolSetting } from "./OpenCodeProtocolSetting";

afterEach(cleanup);

const NAME = "Use OpenCode 2 for new sessions (preview)";

test("legacy is off and turning it on asks for v2", () => {
  const onChange = mock((_value: string) => {});
  render(<OpenCodeProtocolSetting value="legacy" onChange={onChange} />);
  const toggle = screen.getByRole("switch", { name: NAME });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith("v2");
});

test("v2 is on, says what stays on OpenCode 1, and turning it off asks for legacy", () => {
  const onChange = mock((_value: string) => {});
  render(<OpenCodeProtocolSetting value="v2" onChange={onChange} />);
  const toggle = screen.getByRole("switch", { name: NAME });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/Existing sessions stay on OpenCode 1/)).toBeTruthy();
  expect(
    screen.getByText(/Attachments, structured output and slash commands are not available/),
  ).toBeTruthy();
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith("legacy");
});
