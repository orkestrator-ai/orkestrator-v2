import type { CapabilityEnvironmentDelivery } from "@orkestrator/protocol/capability-resources-api";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { providerLabel, shortDigest, StatusBadge } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

/**
 * One environment's own capability copies: a local worktree's project setup
 * (written into the checkout, kept out of Git), or the manifest staged into a
 * container's inputs against the one the current setup would stage. A stale
 * container is refreshed by its existing rebuild; nothing is written into a
 * running container.
 */
export function EnvironmentDeliveryPanel({
  environmentId,
  onRebuild,
}: {
  environmentId: string;
  /** Opens the environment's existing rebuild; absent where that control is already beside it. */
  onRebuild?: () => void;
}) {
  const delivery = useCapabilityResource(
    () => capabilitiesApi.getCapabilityEnvironmentDelivery(environmentId),
    [environmentId],
  );
  const data = delivery.state.data;
  if (!data || data.kind === "none") return null;
  return data.kind === "container" ? (
    <ContainerDelivery data={data} onRebuild={onRebuild} />
  ) : (
    <WorktreeDelivery data={data} />
  );
}

function ContainerDelivery({
  data,
  onRebuild,
}: {
  data: CapabilityEnvironmentDelivery;
  onRebuild?: () => void;
}) {
  return (
    <div
      className="space-y-2 rounded-md border border-zinc-800 p-3 text-xs"
      data-testid="capability-container-delivery"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">In this container</span>
        <StatusBadge
          status={data.stale ? "restart-required" : "installed-next-session"}
          label={data.stale ? "Rebuild to update" : "Up to date"}
        />
      </div>
      <p className="text-muted-foreground">
        Installed revision{" "}
        <code className="text-foreground">
          {data.installedDigest ? shortDigest(data.installedDigest) : "none"}
        </code>{" "}
        · current <code className="text-foreground">{shortDigest(data.currentDigest)}</code>
      </p>
      {data.stale ? (
        <p className="text-muted-foreground">
          Capabilities reach a container through its staged inputs. Rebuild it to stage the current
          setup; the workspace and agent state are kept.
          {onRebuild ? (
            <>
              {" "}
              <button type="button" className="text-sky-300" onClick={onRebuild}>
                Rebuild container…
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <DeliveryItems data={data} />
    </div>
  );
}

function WorktreeDelivery({ data }: { data: CapabilityEnvironmentDelivery }) {
  return (
    <div
      className="space-y-2 rounded-md border border-zinc-800 p-3 text-xs"
      data-testid="capability-worktree-delivery"
    >
      <span className="font-medium text-foreground">In this worktree</span>
      <p className="text-muted-foreground">
        The project's toolkits are written into this checkout's agent folders and listed in the
        repository's local exclude file, so Git never shows them. A file the repository tracks is
        never replaced.
      </p>
      <DeliveryItems data={data} />
    </div>
  );
}

function DeliveryItems({ data }: { data: CapabilityEnvironmentDelivery }) {
  if (data.items.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {data.items.map((item) => (
        <li
          key={`${item.componentId}|${item.locationId ?? item.providers.join(",")}`}
          className="space-y-0.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground">{item.name}</span>
            <StatusBadge status={item.status} title={item.reason} />
            {item.locationLabel ? (
              <code className="text-muted-foreground">{item.locationLabel}</code>
            ) : null}
            <span className="text-muted-foreground">
              {item.providers.map(providerLabel).join(", ")}
            </span>
          </div>
          {item.installedDigest &&
          item.currentDigest &&
          item.installedDigest !== item.currentDigest ? (
            <p className="text-muted-foreground">
              Installed {shortDigest(item.installedDigest)} · current{" "}
              {shortDigest(item.currentDigest)}
            </p>
          ) : null}
          {item.alsoVisibleTo?.length ? (
            <p className="text-muted-foreground">
              Also visible to {item.alsoVisibleTo.map(providerLabel).join(", ")} in this worktree.
            </p>
          ) : null}
          {item.reason ? <p className="text-muted-foreground">{item.reason}</p> : null}
        </li>
      ))}
    </ul>
  );
}
