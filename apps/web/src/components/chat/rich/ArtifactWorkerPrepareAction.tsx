import { useState } from "react";
import { Wrench } from "lucide-react";
import type { ArtifactPrepareWorkerResponse } from "@orkestrator/protocol/transcript-artifact-commands";
import { prepareTranscriptArtifactWorker } from "@/lib/backend/transcript-artifacts";
import {
  refreshTranscriptArtifactCapabilities,
  useTranscriptArtifactCapabilities,
} from "@/hooks/useTranscriptArtifactCapabilities";

type PrepareState =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "done"; result: ArtifactPrepareWorkerResponse }
  | { status: "error"; message: string };

/**
 * "Prepare isolated preview worker": shown when the backend reports that
 * interactive previews have no isolation boundary on this host but it can
 * build (or pull) the container worker, including when a worker prepared
 * before an upgrade is present but out of date. The backend runs Docker with
 * fixed arguments; this only asks it to and reports progress and the outcome.
 */
export function ArtifactWorkerPrepareAction() {
  const capabilities = useTranscriptArtifactCapabilities();
  const [state, setState] = useState<PrepareState>({ status: "idle" });
  const preparation = capabilities?.workerPreparation;
  const unavailable = capabilities?.previewRenderer.interactiveIsolation === "unavailable";
  const backendPreparing = preparation?.state === "preparing";
  if (state.status === "idle" && (!unavailable || !preparation?.available)) return null;

  const prepare = () => {
    setState({ status: "preparing" });
    void prepareTranscriptArtifactWorker()
      .then((result) => {
        setState({ status: "done", result });
        return refreshTranscriptArtifactCapabilities();
      })
      .catch((error: unknown) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The request failed",
        }),
      );
  };

  const busy = state.status === "preparing" || backendPreparing;
  return (
    <div
      className="mt-2 flex flex-col gap-1 rounded border border-border/60 p-2 text-xs"
      data-artifact-worker-prepare={state.status === "done" ? state.result.state : state.status}
    >
      <p className="text-muted-foreground">
        {preparation?.outdated
          ? "Interactive previews need the isolated container worker. The one on this host was prepared by an earlier version of Orkestrator and is out of date; prepare it again."
          : "Interactive previews need the isolated container worker, which is not installed on this host."}
        {capabilities?.previewRenderer.interactiveReason
          ? ` ${capabilities.previewRenderer.interactiveReason}.`
          : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={prepare}
          disabled={busy}
          className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-foreground hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3"
        >
          <Wrench aria-hidden="true" />
          Prepare isolated preview worker
        </button>
        <span role="status" aria-live="polite" className="text-muted-foreground">
          {busy
            ? "Preparing the worker image with Docker; this can take several minutes…"
            : state.status === "error"
              ? `Preparation failed: ${state.message}`
              : state.status === "done"
                ? state.result.state === "ready"
                  ? state.result.interactiveIsolation === "container"
                    ? "Ready: interactive previews now run in container isolation. Ask the agent to preview again."
                    : "The worker image is ready, but this backend's isolation setting keeps interactive previews off."
                  : `Preparation failed: ${state.result.reason ?? "unknown reason"}`
                : ""}
        </span>
      </div>
    </div>
  );
}
