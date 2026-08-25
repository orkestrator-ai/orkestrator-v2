/**
 * The desktop window denies `window.open` and `target="_blank"` outright
 * (`apps/desktop/electron/window.ts`), so anything this pane tried to open
 * itself would silently do nothing — which is exactly how the first version of
 * it failed. These tests pin the resulting contract: the backend opens the
 * browser, and the pane's only fallback is a copyable URL.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CursorSdkLoginProgress } from "@/types";

const invokeCalls: Array<{ command: string }> = [];
let progress: CursorSdkLoginProgress = {
  state: "idle",
  auth: { authenticated: false, source: "none" },
};
let statusError: Error | null = null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string) => {
    invokeCalls.push({ command });
    if (command === "cursor_sdk_login_status") {
      return statusError ? Promise.reject(statusError) : Promise.resolve(progress);
    }
    if (command === "cursor_sdk_login_start") {
      return Promise.resolve({ loginUrl: LOGIN_URL });
    }
    return Promise.resolve(undefined);
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const copied: string[] = [];
mock.module("@/lib/native/clipboard", () => ({
  writeText: mock(async (text: string) => {
    copied.push(text);
  }),
}));

const { CursorSdkSignIn } = await import("./CursorSdkSignIn");

/**
 * Mount and let the pane's initial status read settle.
 *
 * The component fetches on mount, so rendering bare leaves a pending setState
 * that React reports as an unwrapped act() update.
 */
async function mount(credentialRevision = "false:none"): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CursorSdkSignIn credentialRevision={credentialRevision} />);
  });
  return view;
}

const LOGIN_URL = "https://cursor.com/login?challenge=abc";

const pendingProgress: CursorSdkLoginProgress = {
  state: "pending",
  loginUrl: LOGIN_URL,
  auth: { authenticated: false, source: "none" },
};

beforeEach(() => {
  invokeCalls.length = 0;
  copied.length = 0;
  statusError = null;
  progress = { state: "idle", auth: { authenticated: false, source: "none" } };
});

afterEach(cleanup);

describe("starting a sign-in", () => {
  test("asks the backend to start it and never opens a window itself", async () => {
    const openCalls: unknown[] = [];
    const originalOpen = window.open;
    // A pane that called this would look like it worked everywhere except the
    // one place it has to: the desktop window.
    window.open = ((...args: unknown[]) => {
      openCalls.push(args);
      return null;
    }) as typeof window.open;

    try {
      await mount();
      await waitFor(() =>
        expect(invokeCalls.some((c) => c.command === "cursor_sdk_login_status")).toBe(true),
      );

      progress = pendingProgress;
      fireEvent.click(screen.getByRole("button", { name: /Sign in with Cursor/ }));

      await waitFor(() =>
        expect(invokeCalls.some((c) => c.command === "cursor_sdk_login_start")).toBe(true),
      );
      expect(openCalls).toHaveLength(0);
    } finally {
      window.open = originalOpen;
    }
  });
});

describe("the pending fallback", () => {
  test("offers the URL as copyable text rather than a dead link", async () => {
    progress = pendingProgress;
    await mount();

    await waitFor(() => expect(screen.getByText(/Waiting for you to finish/)).toBeDefined());
    // No anchor: one would render as clickable and do nothing in the desktop app.
    expect(document.querySelectorAll('a[target="_blank"]').length).toBe(0);
    expect(screen.getByText(LOGIN_URL)).toBeDefined();
  });

  test("copies the URL through the clipboard helper both hosts share", async () => {
    progress = pendingProgress;
    await mount();

    await waitFor(() => expect(screen.getByRole("button", { name: /Copy link/ })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));

    await waitFor(() => expect(copied).toEqual([LOGIN_URL]));
    await waitFor(() => expect(screen.getByRole("button", { name: /Copied/ })).toBeDefined());
  });

  test("disables the sign-in button while a login is already in flight", async () => {
    progress = pendingProgress;
    await mount();

    await waitFor(() => {
      const button = screen.getByRole("button", { name: /Sign in with Cursor/ });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("cancels the backend-owned login flow", async () => {
    progress = pendingProgress;
    await mount();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(invokeCalls.some((call) => call.command === "cursor_sdk_login_cancel")).toBe(true),
    );
  });

  test("polls a pending flow through to authenticated", async () => {
    progress = pendingProgress;
    await mount();
    progress = {
      state: "authenticated",
      auth: { authenticated: true, source: "stored-login", email: "user@example.com" },
    };

    await waitFor(() => expect(screen.getByText(/Signed in as user@example.com/)).toBeDefined(), {
      timeout: 2_500,
    });
  });
});

describe("reporting which credential is in play", () => {
  test("names a stored login and offers to sign out of it", async () => {
    progress = {
      state: "idle",
      auth: { authenticated: true, source: "stored-login", email: "user@example.com" },
    };
    await mount();

    await waitFor(() => expect(screen.getByText(/Signed in as user@example.com/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() =>
      expect(invokeCalls.some((call) => call.command === "cursor_sdk_logout")).toBe(true),
    );
  });

  test("says when an API key is being used instead, and offers no sign-out", async () => {
    progress = {
      state: "idle",
      auth: { authenticated: true, source: "api-key-env" },
    };
    await mount();

    await waitFor(() =>
      expect(screen.getByText(/Using CURSOR_API_KEY from the environment/)).toBeDefined(),
    );
    // Signing out would not remove an inherited key, so the control is absent
    // rather than present and ineffective.
    expect(screen.queryByRole("button", { name: /Sign out/ }) === null).toBe(true);
  });

  test("surfaces a failed login without pretending it is still pending", async () => {
    progress = {
      state: "failed",
      error: "Cursor sign-in did not complete",
      auth: { authenticated: false, source: "none" },
    };
    await mount();

    await waitFor(() => expect(screen.getByText(/did not complete/)).toBeDefined());
    expect(screen.queryByText(/Waiting for you to finish/) === null).toBe(true);
  });

  test("refreshes when the stored API-key configuration changes", async () => {
    const view = await mount("false:none");
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeDefined());

    progress = {
      state: "idle",
      auth: { authenticated: true, source: "api-key-config" },
    };
    view.rerender(<CursorSdkSignIn credentialRevision="true:config" />);

    await waitFor(() => expect(screen.getByText("Using the stored Cursor API key")).toBeDefined());
  });

  test("clears a transient status error after a successful refresh", async () => {
    statusError = new Error("backend restarting");
    const view = await mount("false:none");
    await waitFor(() => expect(screen.getByText("backend restarting")).toBeDefined());

    statusError = null;
    progress = { state: "idle", auth: { authenticated: false, source: "none" } };
    view.rerender(<CursorSdkSignIn credentialRevision="false:cleared" />);

    await waitFor(() => expect(screen.queryByText("backend restarting") === null).toBe(true));
  });
});
