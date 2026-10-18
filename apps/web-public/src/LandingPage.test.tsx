import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LandingPage } from "./LandingPage";
import { CONNECT_PATH, isConnectPath } from "./routes";

afterEach(() => {
  cleanup();
});

describe("LandingPage", () => {
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
