/**
 * The lifetime engine under `WindowScope`, `NodeScope` and scoped services.
 *
 * A `Lifetime` is a thin, synchronous face over an Effect `Scope.Closeable`
 * (effect 4). Effect gives the tree its semantics, so they are not
 * reimplemented here:
 *
 * - finalizers run in reverse order of registration when the scope closes;
 * - a child scope (`child()`) closes with its parent, and closing it early
 *   detaches it from the parent, so the parent does not keep it alive;
 * - closing is idempotent, and a finalizer added after close runs at once.
 *
 * The tree is: one window lifetime per renderer, one child per node scope,
 * one grandchild per running scoped service. Stores and byte-budget
 * reservations register finalizers on their node's lifetime.
 *
 * Callers never see Effect. Every finalizer here is a plain synchronous
 * function wrapped in `Effect.sync`, and `Effect.runSync` runs registration and
 * close at the boundary, so `dispose()` stays synchronous for React and plain
 * modules. A finalizer that throws is caught and logged (content-free) so the
 * remaining finalizers still run and `close()` never throws.
 */

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";

const log = createLogger("web.node-scope");

export class Lifetime {
  private constructor(
    private readonly scope: Scope.Closeable,
    /** A bounded label for logs (`"node:command"`, `"service:resource-sync"`); never content. */
    readonly label: string,
  ) {}

  /** A lifetime with no parent: the window's. */
  static root(label: string): Lifetime {
    return new Lifetime(Scope.makeUnsafe("sequential"), label);
  }

  /** A lifetime that ends no later than this one. Throws once this one has closed. */
  child(label: string): Lifetime {
    if (this.closed) throw new Error(`Cannot open ${label}: ${this.label} has ended.`);
    return new Lifetime(Scope.forkUnsafe(this.scope, "sequential"), label);
  }

  get closed(): boolean {
    return this.scope.state._tag === "Closed";
  }

  /**
   * Runs `finalizer` when this lifetime ends, after every finalizer registered
   * later. On a lifetime that has already ended it runs immediately.
   */
  onClose(name: string, finalizer: () => void): void {
    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.sync(() => runGuarded(this.label, name, finalizer)),
      ),
    );
  }

  /** Ends this lifetime and every child, running their finalizers. Idempotent. */
  close(): void {
    Effect.runSync(Scope.close(this.scope, Exit.void));
  }
}

function runGuarded(lifetime: string, name: string, finalizer: () => void): void {
  try {
    finalizer();
  } catch (error) {
    log.warn("finalizer.failed", { lifetime, finalizer: name, error: logErrorKind(error) });
  }
}
