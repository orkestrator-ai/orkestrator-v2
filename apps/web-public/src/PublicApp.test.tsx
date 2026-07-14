import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearDirectGatewayTransport } from "@/lib/native/gateway-auth-transport";
import { PublicApp } from "./PublicApp";
import { loadSavedConnection, saveConnection } from "./connection";

// The real @/App pulls in the entire renderer; the stub keeps the connected
// state observable without booting it. No other web-public suite imports @/App.
mock.module("@/App", () => ({ default: () => <div>Main app stub</div> }));

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalReload = window.location.reload;
const originalUrl = window.location.href;
const token = "gateway-token-123456";
const pageWindow = window as unknown as { happyDOM: { setURL(url: string): void } };

beforeAll(() => {
  // The connection screen is deployed on an HTTPS origin; several branches
  // (gateway install, insecure-backend warning) are gated on that protocol.
  pageWindow.happyDOM.setURL("https://public.example/");
});

afterAll(() => {
  pageWindow.happyDOM.setURL(originalUrl);
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  clearDirectGatewayTransport();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  window.location.reload = originalReload;
  delete window.orkestrator;
  delete window.orkestratorGateway;
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

  test("connects, installs the direct gateway, and exposes connection switching", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch;
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<PublicApp />);

    fireEvent.change(screen.getByLabelText("Backend address"), {
      target: { value: "https://workstation.example/" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: ` ${token} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Connect directly" }));

    await screen.findByText("Main app stub");
    expect(loadSavedConnection()).toEqual({
      address: "https://workstation.example",
      token,
    });
    expect(window.orkestratorGateway).toEqual({
      enabled: true,
      baseUrl: "https://workstation.example",
    });
    expect(typeof window.orkestrator?.invoke).toBe("function");
    expect((await window.orkestrator?.connections?.list())?.connections[0]).toMatchObject({
      name: "workstation.example",
      active: true,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  test("warns when this HTTPS page targets a plain-HTTP backend", () => {
    render(<PublicApp />);

    fireEvent.change(screen.getByLabelText("Backend address"), {
      target: { value: "http://127.0.0.1:34121" },
    });
    expect(screen.getByText(/Most browsers will block/).id).toBe("backend-warning");

    fireEvent.change(screen.getByLabelText("Backend address"), {
      target: { value: "https://workstation.example" },
    });
    expect(screen.queryByText(/Most browsers will block/)).toBeNull();
  });

  test("reveals the token and forgets saved browser credentials", () => {
    saveConnection({ address: "https://workstation.example", token });
    sessionStorage.clear();
    render(<PublicApp />);

    const tokenInput = screen.getByLabelText("Gateway token");
    expect(tokenInput.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show gateway token" }));
    expect(tokenInput.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Forget saved connection" }));

    expect(loadSavedConnection()).toEqual({ address: "", token: "" });
    expect(screen.queryByRole("button", { name: "Forget saved connection" })).toBeNull();
  });

  test("aborts an automatic connection check when unmounted", async () => {
    saveConnection({ address: "https://workstation.example", token });
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

  test("switches and forgets saved servers through the mounted browser connection API", async () => {
    saveConnection({ address: "https://one.example", token: "gateway-token-one-123456" });
    saveConnection({ address: "https://two.example", token: "gateway-token-two-123456" });
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    render(<PublicApp />);
    await screen.findByText("Main app stub");

    const api = window.orkestrator?.connections;
    const one = (await api?.list())?.connections.find((connection) => connection.address === "https://one.example");
    expect(one).toBeTruthy();
    await api?.use(one?.id ?? "missing");
    expect(loadSavedConnection()).toEqual({ address: "https://one.example", token: "gateway-token-one-123456" });
    const afterForget = await api?.forget(one?.id ?? "missing");
    expect(afterForget?.connections.some((connection) => connection.address === "https://one.example")).toBe(false);
    expect(loadSavedConnection()).toEqual({ address: "", token: "" });
  });
});
