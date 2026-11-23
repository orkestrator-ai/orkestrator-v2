/**
 * Process-wide report of this backend creating or removing a Docker network.
 *
 * The agent-tools server admits container peers by the subnets of this
 * backend's networks (`agent-tools-peer-filter.ts`), so every place that
 * creates or removes one reports it here. A listener must not throw and must
 * not block: it is called synchronously from the network code.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeDockerNetworkChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportDockerNetworkChange(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A listener's failure must not fail the network operation that reported it.
    }
  }
}
