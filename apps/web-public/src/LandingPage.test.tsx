import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { LandingPage } from "./LandingPage";
import { CONNECT_PATH, isConnectPath } from "./routes";

afterEach(() => {
  cleanup();
  spyOn(navigator.clipboard, "writeText").mockRestore();
});

describe("LandingPage", () => {
  const expectedCommand =
    "curl -fsSL https://orkestrator.dev/install.sh | bash -s -- --tailscale-serve --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev";

  test("displays and copies the published install arguments for both hosted origins", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<LandingPage />);

    expect(screen.getByText(expectedCommand).textContent).toBe(`$ ${expectedCommand}`);
    // Keep the landing command aligned with the published installation example.
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const publishedCommand = readme.match(
      /curl -fsSL https:\/\/orkestrator\.dev\/install\.sh[^`]+/,
    )?.[0];
    expect(publishedCommand?.replace(/\\\n\s*/g, "").trim()).toBe(expectedCommand);
    fireEvent.click(screen.getByRole("button", { name: "Copy install command" }));

    await screen.findByRole("button", { name: "Install command copied" });
    expect(writeText).toHaveBeenCalledWith(expectedCommand);
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Copy install command" })).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  test("keeps the command selectable and allows retry after clipboard refusal", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new DOMException("Clipboard denied", "NotAllowedError"))
      .mockResolvedValue(undefined);
    render(<LandingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Copy install command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Install command copied" }) === null).toBe(true);
    expect(screen.getByText(expectedCommand)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy install command" }));
    await screen.findByRole("button", { name: "Install command copied" });
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  test("sends the login buttons to the connect page", () => {
    render(<LandingPage />);

    const logins = screen.getAllByRole("link", { name: "Log in to your Orkestrator backend" });
    expect(logins.length).toBeGreaterThan(0);
    for (const link of logins) expect(link.getAttribute("href")).toBe(CONNECT_PATH);
    expect(screen.getByRole("link", { name: "Log in" }).getAttribute("href")).toBe(CONNECT_PATH);
  });

  test("covers container security, pipelines and multi review", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: /Isolation is the default/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Build pipelines" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Multi Review" })).toBeTruthy();
    expect(document.getElementById("security")).toBeTruthy();
    expect(document.getElementById("multi-review")).toBeTruthy();
  });
});

describe("isConnectPath", () => {
  test("matches only the connect page", () => {
    expect(isConnectPath("/connect")).toBe(true);
    expect(isConnectPath("/connect/")).toBe(true);
    expect(isConnectPath("/")).toBe(false);
    expect(isConnectPath("/connections")).toBe(false);
  });
});
