import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicApp } from "./PublicApp";
import { loadSavedConnection, saveConnection, SKIP_AUTO_CONNECT_KEY } from "./connection";

const originalFetch = globalThis.fetch;
const token = "gateway-token-123456";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("PublicApp connection form", () => {
  test("submits credentials and restores the form after a rejected token", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    render(<PublicApp />);

    fireEvent.change(screen.getByLabelText("Backend address"), {
      target: { value: "https://workstation.example" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Connect directly" }));

    expect((await screen.findByRole("alert")).textContent).toContain("token was rejected");
    expect((screen.getByRole("button", { name: "Connect directly" }) as HTMLButtonElement).disabled).toBe(false);
    expect(loadSavedConnection().address).toBe("");
  });

  test("reveals the token and forgets saved browser credentials", () => {
    saveConnection({ address: "https://workstation.example", token, rememberToken: true });
    sessionStorage.setItem(SKIP_AUTO_CONNECT_KEY, "1");
    render(<PublicApp />);

    const tokenInput = screen.getByLabelText("Gateway token");
    expect(tokenInput.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show gateway token" }));
    expect(tokenInput.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Forget saved connection" }));

    expect(loadSavedConnection()).toEqual({ address: "", token: "", rememberToken: false });
    expect(screen.queryByRole("button", { name: "Forget saved connection" })).toBeNull();
  });

  test("aborts an automatic connection check when unmounted", async () => {
    saveConnection({ address: "https://workstation.example", token, rememberToken: false });
    let aborted = false;
    globalThis.fetch = mock((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal?.reason);
      }, { once: true });
    })) as unknown as typeof fetch;

    const view = render(<PublicApp />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(aborted).toBe(true);
  });
});
