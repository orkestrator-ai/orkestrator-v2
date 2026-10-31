import type {
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";

export interface OpenCodeLoginOperation {
  progress: OpenCodeProviderLoginProgress;
  controller: AbortController;
  submitCode?: (code: string) => void;
  cancelled?: boolean;
}

/**
 * One backend's OpenCode provider sign-in: the operation in progress, the
 * reservation that lets one login change run at a time, and the provider list
 * single flight. Owned by `LocalServerRuntime` as `openCodeProviderLogin` and
 * driven by `createOpenCodeProviderLogin` in `opencode-provider-login.ts`, which
 * cannot be constructed here because it reaches the server modules that import
 * `local-server-runtime.ts`.
 */
export class OpenCodeProviderLoginSlot {
  private current: OpenCodeLoginOperation | undefined;
  private mutation: symbol | undefined;
  private listFlight: Promise<OpenCodeProviderAuthSnapshot> | undefined;

  progress(): OpenCodeProviderLoginProgress {
    return this.current ? { ...this.current.progress } : { state: "idle" };
  }

  /** One server answers every settings pane that asks at once. */
  listProviders(
    read: () => Promise<OpenCodeProviderAuthSnapshot>,
  ): Promise<OpenCodeProviderAuthSnapshot> {
    this.listFlight ??= read().finally(() => {
      this.listFlight = undefined;
    });
    return this.listFlight;
  }

  /** Reserves the one login change allowed at a time; returns its release. */
  reserveMutation(): () => void {
    if (this.mutation) {
      throw new Error(
        "Another OpenCode sign-in is in progress or a login change is finishing. Finish or cancel it first.",
      );
    }
    const reservation = Symbol();
    this.mutation = reservation;
    return () => {
      if (this.mutation === reservation) this.mutation = undefined;
    };
  }

  begin(operation: OpenCodeLoginOperation): void {
    this.current = operation;
  }

  isCurrent(operation: OpenCodeLoginOperation): boolean {
    return this.current === operation;
  }

  clear(): void {
    this.current = undefined;
  }

  /** The operation waiting for a code, with its submit callback taken. */
  submitCode(code: string): OpenCodeProviderLoginProgress {
    if (!this.current?.submitCode || this.current.progress.state !== "pending") {
      throw new Error("No OpenCode sign-in is waiting for a code");
    }
    const submit = this.current.submitCode;
    this.current.submitCode = undefined;
    this.current.progress = { ...this.current.progress, codeSubmitted: true };
    submit(code);
    return this.progress();
  }

  cancel(operationId?: string): OpenCodeProviderLoginProgress {
    if (
      this.current?.progress.state === "pending" &&
      (!operationId || this.current.progress.operationId === operationId)
    ) {
      // Keep the reservation and pending snapshot until the server stops.
      this.current.cancelled = true;
      this.current.submitCode = undefined;
      this.current.controller.abort(new Error("Sign-in cancelled."));
    }
    return this.progress();
  }
}
