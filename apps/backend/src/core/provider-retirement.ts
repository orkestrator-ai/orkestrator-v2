import type { BuildPipelineProvider } from "./build-pipeline-provider.js";

interface ProviderLifetime {
  retain(): () => void;
  retire(): Promise<void>;
}

const lifetimes = new WeakMap<BuildPipelineProvider, ProviderLifetime>();
const managedProviders = new WeakMap<
  BuildPipelineProvider,
  {
    provider: BuildPipelineProvider;
    retired(): boolean;
  }
>();

/**
 * A cached provider may be evicted while another reviewer or transcript reader
 * is using it. Count calls by instance, and allow compound operations to hold
 * a lease across their awaits. Retirement never aborts those consumers.
 */
export function managedProvider(provider: BuildPipelineProvider): BuildPipelineProvider {
  const existing = managedProviders.get(provider);
  if (existing && !existing.retired()) return existing.provider;
  if (lifetimes.has(provider)) return provider;
  let users = 0;
  let retired = false;
  let disposal: Promise<void> | undefined;
  let finish: (() => void) | undefined;
  let cleanupQueued = false;
  const disposeWhenUnused = () => {
    if (!retired || users !== 0 || !finish || cleanupQueued) return;
    cleanupQueued = true;
    void Promise.resolve().then(() => {
      cleanupQueued = false;
      // A caller may have acquired a compound lease since cleanup was queued.
      if (users !== 0 || !finish) return;
      const resolveDisposal = finish;
      finish = undefined;
      // An unreachable transport's cleanup must not produce an unhandled
      // rejection or fail a peer's otherwise successful operation.
      return Promise.resolve()
        .then(() => provider.dispose?.())
        .catch(() => undefined)
        .then(resolveDisposal);
    });
  };
  const lifetime: ProviderLifetime = {
    retain() {
      users += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users -= 1;
        disposeWhenUnused();
      };
    },
    retire() {
      if (!disposal) {
        retired = true;
        disposal = new Promise<void>((resolve) => {
          finish = resolve;
        });
        disposeWhenUnused();
      }
      return disposal;
    },
  };
  const managed = new Proxy(provider, {
    get(target, key) {
      if (key === "dispose") return () => lifetime.retire();
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const release = lifetime.retain();
        try {
          const result: unknown = Reflect.apply(value, target, args);
          if (result instanceof Promise) return result.finally(release);
          release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      };
    },
  });
  lifetimes.set(managed, lifetime);
  managedProviders.set(provider, { provider: managed, retired: () => retired });
  return managed;
}

/** Protect an entire observation/dispatch, including gaps between provider calls. */
export function retainProvider(provider: BuildPipelineProvider): () => void {
  return lifetimes.get(provider)?.retain() ?? (() => {});
}

/** Detach from the cache first; cleanup completes when the last consumer leaves. */
export function retireProvider(provider: BuildPipelineProvider): void {
  const lifetime = lifetimes.get(provider);
  if (lifetime) {
    void lifetime.retire();
    return;
  }
  void Promise.resolve()
    .then(() => provider.dispose?.())
    .catch(() => undefined);
}
