import type { CursorSdkLoginHandle, CursorSdkLoginState } from "./cursor-sdk-bridge.js";

interface CursorSdkLoginStartup {
  promise: Promise<CursorSdkLoginHandle>;
  controller: AbortController;
  cancelled: boolean;
}

/**
 * The single in-flight Cursor SDK login of one backend, held in the backend
 * rather than the renderer. Owned by `LocalServerRuntime` as `cursorSdkLogin`
 * and driven by `startCursorSdkLogin`, `cursorSdkLoginProgress` and
 * `cancelCursorSdkLogin` in `cursor-sdk-bridge.ts`.
 *
 * One at a time: a second concurrent flow would mint a second key and race to
 * persist it. Keeping the handle here is also what lets the settings pane be a
 * plain view — it starts a login and polls a status, and every decision about
 * spawning, parsing, storing and cancelling stays on this side.
 */
export class CursorSdkLoginSlot {
  private active:
    | { handle: CursorSdkLoginHandle; state: CursorSdkLoginState; error?: string }
    | undefined;
  private startup: CursorSdkLoginStartup | undefined;

  /** Joins the pending login, or begins one with `begin`. */
  async start(
    begin: (signal: AbortSignal) => Promise<CursorSdkLoginHandle>,
  ): Promise<{ loginUrl: string }> {
    if (this.active?.state === "pending") return { loginUrl: this.active.handle.loginUrl };
    if (this.startup) {
      const startup = this.startup;
      try {
        const handle = await startup.promise;
        if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
        return { loginUrl: handle.loginUrl };
      } catch (error) {
        if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
        throw error;
      }
    }

    const controller = new AbortController();
    const startup: CursorSdkLoginStartup = {
      promise: begin(controller.signal),
      controller,
      cancelled: false,
    };
    this.startup = startup;
    let handle: CursorSdkLoginHandle;
    try {
      handle = await startup.promise;
    } catch (error) {
      if (this.startup === startup) this.startup = undefined;
      if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
      throw error;
    }
    if (this.startup === startup) this.startup = undefined;
    if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
    const entry = {
      handle,
      state: "pending" as CursorSdkLoginState,
      error: undefined as string | undefined,
    };
    this.active = entry;
    void handle.completion.then(
      () => {
        entry.state = "authenticated";
      },
      (error: unknown) => {
        entry.state = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
      },
    );
    return { loginUrl: handle.loginUrl };
  }

  progress(): { state: CursorSdkLoginState; loginUrl?: string; error?: string } {
    if (this.startup) return { state: "pending" };
    if (!this.active) return { state: "idle" };
    return {
      state: this.active.state,
      loginUrl: this.active.handle.loginUrl,
      ...(this.active.error ? { error: this.active.error } : {}),
    };
  }

  cancel(): void {
    if (this.startup) {
      this.startup.cancelled = true;
      this.startup.controller.abort();
    }
    this.active?.handle.cancel();
    this.active = undefined;
  }
}
