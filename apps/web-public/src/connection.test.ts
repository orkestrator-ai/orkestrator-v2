import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  checkBackendConnection,
  forgetConnection,
  insecureBackendWarning,
  listBrowserConnections,
  loadSavedConnection,
  normalizeBackendAddress,
  saveConnection,
  selectBrowserConnection,
  updateSavedToken,
} from "./connection";

const originalFetch = globalThis.fetch;
const token = "gateway-token-123456";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("public backend address", () => {
  test("defaults hostnames to HTTPS and removes the root slash", () => {
    expect(normalizeBackendAddress("workstation.tailnet.ts.net")).toBe(
      "https://workstation.tailnet.ts.net",
    );
    expect(normalizeBackendAddress(" http://127.0.0.1:34121/ ")).toBe(
      "http://127.0.0.1:34121",
    );
  });

  test("rejects empty, malformed, credentialed, non-HTTP, and non-origin addresses", () => {
    expect(() => normalizeBackendAddress(" ")).toThrow("Enter the backend address");
    expect(() => normalizeBackendAddress("://")).toThrow("valid backend URL");
    expect(() => normalizeBackendAddress("https://token@example.com")).toThrow("token field");
    expect(() => normalizeBackendAddress("https://example.com/gateway")).toThrow("origin only");
    expect(() => normalizeBackendAddress("https://example.com/?query=1")).toThrow("origin only");
    expect(() => normalizeBackendAddress("https://example.com/#fragment")).toThrow("origin only");
    expect(() => normalizeBackendAddress("file:///tmp/backend")).toThrow("HTTP or HTTPS");
  });

  test("warns only when an HTTPS page targets a valid HTTP backend", () => {
    expect(insecureBackendWarning("http://127.0.0.1:34121", "https:")).toContain("will block");
    expect(insecureBackendWarning("https://workstation.example", "https:")).toBeNull();
    expect(insecureBackendWarning("not a URL", "https:")).toBeNull();
    expect(insecureBackendWarning("http://127.0.0.1:34121", "http:")).toBeNull();
  });
});

describe("saved public connection", () => {
  test("stores recent connection metadata locally and the token only for the tab", () => {
    saveConnection({ address: "https://one.example", token });

    expect(loadSavedConnection()).toEqual({
      address: "https://one.example",
      token,
    });
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(listBrowserConnections().connections[0]).toMatchObject({
      address: "https://one.example",
      active: true,
      requiresToken: false,
    });
  });

  test("keeps the recent server but requires its token in a new browser session", () => {
    saveConnection({ address: "https://one.example", token });
    sessionStorage.clear();
    expect(loadSavedConnection()).toEqual({
      address: "https://one.example",
      token: "",
    });
    expect(listBrowserConnections().connections[0]?.requiresToken).toBe(true);
  });

  test("removes legacy persistent tokens and migrates only the old tab token", () => {
    localStorage.setItem("orkestrator.public.backend-address", "https://one.example");
    localStorage.setItem("orkestrator.public.remembered-gateway-token", "persistent-token-must-not-survive");
    sessionStorage.setItem("orkestrator.public.gateway-token", token);

    expect(loadSavedConnection()).toEqual({ address: "https://one.example", token });
    expect(localStorage.getItem("orkestrator.public.remembered-gateway-token")).toBeNull();
    expect(sessionStorage.getItem("orkestrator.public.gateway-token")).toBeNull();
  });

  test("rotates the tab token and forgets the connection", () => {
    saveConnection({ address: "https://one.example", token });
    updateSavedToken("replacement-token-123456");
    expect(loadSavedConnection().token).toBe("replacement-token-123456");
    forgetConnection();
    expect(loadSavedConnection()).toEqual({ address: "", token: "" });
    expect(listBrowserConnections().connections).toEqual([]);
  });

  test("switches between recent servers using their tab-scoped tokens", () => {
    saveConnection({ address: "https://one.example", token: "gateway-token-one-123456" });
    saveConnection({ address: "https://two.example", token: "gateway-token-two-123456" });
    const one = listBrowserConnections().connections.find((connection) => connection.address === "https://one.example");
    const oneId = one?.id ?? "";
    expect(oneId).not.toBe("");

    selectBrowserConnection(oneId);

    expect(loadSavedConnection()).toEqual({
      address: "https://one.example",
      token: "gateway-token-one-123456",
    });
    expect(listBrowserConnections().activeConnectionId).toBe(oneId);
  });
});

describe("public backend connection check", () => {
  test("normalizes credentials and accepts a healthy backend", async () => {
    globalThis.fetch = mock(async (input, init) => {
      expect(input).toBe("https://workstation.example/__orkestrator/status");
      expect(init?.credentials).toBe("omit");
      expect(init?.mode).toBe("cors");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(checkBackendConnection(" workstation.example ", ` ${token} `)).resolves.toBe(
      "https://workstation.example",
    );
  });

  test("reports authentication, origin, backend, and malformed success responses", async () => {
    globalThis.fetch = mock()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "policy denied" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 })) as unknown as typeof fetch;

    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("token was rejected");
    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("allowed origins");
    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("policy denied");
    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("backend unavailable");
    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("HTTP 200");
  });

  test("validates the token and timeout before sending a request", async () => {
    const request = mock(async () => new Response("{}"));
    globalThis.fetch = request as unknown as typeof fetch;

    await expect(checkBackendConnection("https://one.example", "short")).rejects.toThrow("at least 16");
    await expect(checkBackendConnection("https://one.example", token, { timeoutMs: 0 })).rejects.toThrow(
      "positive number",
    );
    await expect(checkBackendConnection("https://one.example", token, { timeoutMs: Number.NaN })).rejects.toThrow(
      "positive number",
    );
    expect(request).not.toHaveBeenCalled();
  });

  test("distinguishes network errors, timeout, and caller cancellation", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(checkBackendConnection("https://one.example", token)).rejects.toThrow("Could not reach");

    globalThis.fetch = mock((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    await expect(checkBackendConnection("https://one.example", token, { timeoutMs: 1 })).rejects.toThrow(
      "0.001 seconds",
    );

    const controller = new AbortController();
    const pending = checkBackendConnection("https://one.example", token, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  test("keeps the timeout active while reading the status response body", async () => {
    globalThis.fetch = mock(async (_input, init) => ({
      status: 200,
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    }) as Response) as unknown as typeof fetch;

    await expect(checkBackendConnection("https://one.example", token, { timeoutMs: 1 })).rejects.toThrow(
      "0.001 seconds",
    );
  });
});
