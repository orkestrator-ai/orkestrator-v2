/**
 * Process state owned by one backend instance.
 *
 * Replaces the module-level maps and singletons in `commands-runtime-state.ts`
 * one cluster at a time (docs/2026-10-14/runtime-state-ownership.md). The
 * backend constructs one in `index.ts` and passes it as
 * `CommandContext.runtime`; command fixtures build a fresh one per context, so
 * two backends in one process never share state.
 *
 * Always reach it through the context at call time. Destructuring it at module
 * load would freeze one instance's state into every later caller.
 */
export class BackendRuntime {
  /** Releases everything the runtime owns; called once on backend shutdown. */
  shutdown(): void {}
}
