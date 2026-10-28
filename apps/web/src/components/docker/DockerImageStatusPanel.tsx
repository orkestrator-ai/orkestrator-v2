import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import type { HostTask } from "@orkestrator/protocol/host-maintenance";
import type {
  DockerTopology,
  ImageCompatibilityState,
  ImageStatus,
} from "@orkestrator/protocol/image-manifest";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";

const STATE_LABEL: Record<ImageCompatibilityState, string> = {
  compatible: "Compatible",
  legacy: "Legacy image",
  incompatible: "Incompatible",
  missing: "Not downloaded",
  unavailable: "Unknown",
};

const TOPOLOGY_LABEL: Record<DockerTopology["kind"], string> = {
  "local-engine": "Local Docker Engine",
  desktop: "Docker Desktop",
  remote: "Remote daemon (unsupported)",
  unknown: "Endpoint unknown",
  unavailable: "Not reachable",
};

/** Image states a download of the release image fixes. */
const DOWNLOADABLE: ReadonlySet<ImageCompatibilityState> = new Set([
  "missing",
  "legacy",
  "incompatible",
]);

const TASK_POLL_MS = 2_000;

function shortId(id: string | null): string | null {
  return id ? id.replace(/^sha256:/, "").slice(0, 12) : null;
}

/**
 * The Docker daemon and the configured environment image, as the backend sees
 * them. Docker being unreachable and the image being absent are reported
 * separately: the first needs Docker started, the second only a download.
 * Reads its own snapshot so the Docker dialog stays a thin shell.
 */
export function DockerImageStatusPanel() {
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [topology, setTopology] = useState<DockerTopology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The host's image-update task, which an environment create may also start.
  const [download, setDownload] = useState<HostTask | null>(null);
  const [starting, setStarting] = useState(false);

  const fetchStatus = useCallback(
    (refresh: boolean) =>
      Promise.all([
        backend.getDockerImageStatus(),
        backend.getDockerTopology(refresh),
        backend.getHostMaintenance().catch(() => null),
      ])
        .then(([imageStatus, daemon, maintenance]) => {
          setImage(imageStatus);
          setTopology(daemon);
          setDownload(maintenance?.tasks["image-update"] ?? null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false)),
    [],
  );

  const load = (refresh: boolean) => {
    setLoading(true);
    setError(null);
    void fetchStatus(refresh);
  };

  useEffect(() => {
    void fetchStatus(false);
  }, [fetchStatus]);

  const downloading = download?.state === "running";

  // Follow a running download from the authoritative snapshot, then re-read
  // the image once it finishes.
  useEffect(() => {
    if (!downloading) return;
    let active = true;
    const timer = setInterval(() => {
      void backend
        .getHostMaintenance()
        .then((maintenance) => {
          if (!active) return;
          const task = maintenance.tasks["image-update"] ?? null;
          setDownload(task);
          if (task?.state !== "running") void fetchStatus(false);
        })
        .catch(() => undefined);
    }, TASK_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [downloading, fetchStatus]);

  const startDownload = () => {
    setStarting(true);
    setError(null);
    void backend
      .startHostImageUpdate()
      .then(setDownload)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false));
  };

  const dockerReachable = topology != null && topology.kind !== "unavailable";
  const healthy = image?.state === "compatible";
  const capabilities = image?.manifest
    ? Object.entries(image.manifest.capabilities)
        .map(([name, version]) => `${name} v${version}`)
        .join(", ")
    : null;

  return (
    <section className="space-y-3" aria-labelledby="docker-image-status-heading">
      <div className="flex items-center justify-between">
        <h3 id="docker-image-status-heading" className="text-sm font-medium">
          Environment image
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => load(true)}
          disabled={loading}
          aria-label="Refresh image status"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {loading && !image ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking image…
        </div>
      ) : error && !image ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : image && topology ? (
        <div className="space-y-3 rounded-md border border-zinc-700 bg-zinc-800/50 p-3 text-sm">
          <div className="flex items-center gap-2">
            {dockerReachable ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
            )}
            <span className="w-14 shrink-0 text-muted-foreground">Docker</span>
            <span className="font-medium">
              {TOPOLOGY_LABEL[topology.kind]}
              {topology.serverVersion ? ` ${topology.serverVersion}` : ""}
              {topology.rootless ? " · rootless" : ""}
            </span>
          </div>
          {topology.remediation && <p className="text-xs">{topology.remediation}</p>}

          {dockerReachable && (
            <>
              <div className="flex items-center gap-2">
                {healthy ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />
                ) : image.state === "legacy" || image.state === "missing" ? (
                  <AlertCircle className="h-4 w-4 text-yellow-500" aria-hidden="true" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
                )}
                <span className="w-14 shrink-0 text-muted-foreground">Image</span>
                <span className="font-medium">{STATE_LABEL[image.state]}</span>
                <span className="truncate text-muted-foreground">{image.imageRef}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {shortId(image.imageId) && (
                  <>
                    <dt>Image id</dt>
                    <dd className="font-mono">{shortId(image.imageId)}</dd>
                  </>
                )}
                {shortId(image.registryDigest) && (
                  <>
                    <dt>Digest</dt>
                    <dd className="font-mono">{shortId(image.registryDigest)}</dd>
                  </>
                )}
                {image.manifest && (
                  <>
                    <dt>Built from</dt>
                    <dd>
                      {image.manifest.appVersion}
                      {image.manifest.sourceRevision
                        ? ` (${image.manifest.sourceRevision.slice(0, 8)})`
                        : ""}
                    </dd>
                    <dt>Contracts</dt>
                    <dd>{capabilities || "none"}</dd>
                  </>
                )}
                {image.missingCapabilities.length > 0 && (
                  <>
                    <dt>Missing</dt>
                    <dd>{image.missingCapabilities.join(", ")}</dd>
                  </>
                )}
              </dl>
              {image.remediation && <p className="text-xs">{image.remediation}</p>}
              {downloading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {download?.stage ?? "Downloading the environment image…"}
                </div>
              ) : (
                DOWNLOADABLE.has(image.state) && (
                  <Button variant="outline" size="sm" onClick={startDownload} disabled={starting}>
                    {starting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Download image
                  </Button>
                )
              )}
              {download?.state === "failed" && download.error && !healthy && (
                <p className="text-xs text-destructive">Download failed: {download.error}</p>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
