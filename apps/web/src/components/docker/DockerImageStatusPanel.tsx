import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
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
  missing: "Not installed",
  unavailable: "Unavailable",
};

const TOPOLOGY_LABEL: Record<DockerTopology["kind"], string> = {
  "local-engine": "Local Docker Engine",
  desktop: "Docker Desktop",
  remote: "Remote daemon (unsupported)",
  unknown: "Endpoint unknown",
  unavailable: "Unavailable",
};

function shortId(id: string | null): string | null {
  return id ? id.replace(/^sha256:/, "").slice(0, 12) : null;
}

/**
 * The configured environment image and the daemon it runs on, as the backend
 * sees them. Reads its own snapshot so the Docker dialog stays a thin shell.
 */
export function DockerImageStatusPanel() {
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [topology, setTopology] = useState<DockerTopology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [imageStatus, daemon] = await Promise.all([
        backend.getDockerImageStatus(),
        backend.getDockerTopology(refresh),
      ]);
      setImage(imageStatus);
      setTopology(daemon);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
          onClick={() => void load(true)}
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
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : image ? (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-800/50 p-3 text-sm">
          <div className="flex items-center gap-2">
            {healthy ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />
            ) : image.state === "legacy" ? (
              <AlertCircle className="h-4 w-4 text-yellow-500" aria-hidden="true" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
            )}
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
            {topology && (
              <>
                <dt>Daemon</dt>
                <dd>
                  {TOPOLOGY_LABEL[topology.kind]}
                  {topology.serverVersion ? ` ${topology.serverVersion}` : ""}
                  {topology.rootless ? " · rootless" : ""}
                </dd>
              </>
            )}
          </dl>
          {image.remediation && <p className="text-xs">{image.remediation}</p>}
          {topology?.remediation && <p className="text-xs">{topology.remediation}</p>}
        </div>
      ) : null}
    </section>
  );
}
