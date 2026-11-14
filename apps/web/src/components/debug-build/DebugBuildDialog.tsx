import { useRef, useState } from "react";
import { Bug, ImageOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  debugBuildRequestIdentity,
  MAX_DEBUG_BUILD_EXPECTED_LENGTH,
  MAX_DEBUG_BUILD_PROBLEM_LENGTH,
  type CreateDebugBuildInput,
} from "@orkestrator/protocol/debug-build";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { backendApiForScope } from "@/lib/backend/client";
import { createBuildPipelinesApi, createDebugBuild } from "@/lib/backend/build-pipelines";
import { activateFeatureBuildEnvironment } from "@/lib/feature-build-activation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import { createUuid } from "@/lib/uuid";
import { useDebugBuildStore, type DebugBuildTarget } from "@/stores/debugBuildStore";
import { environmentStore } from "@/stores/environmentStore";

const log = createLogger("web.build-pipeline");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

/**
 * The window's debug dialog, on the scope of the node the environment is on:
 * this window's own backend, or another node shown in its tree. A target
 * whose node has left the window is reported rather than sent elsewhere.
 */
export function DebugBuildDialogHost() {
  const open = useDebugBuildStore((state) => state.open);
  const target = useDebugBuildStore((state) => state.target);
  const { windowScope, scope: own } = useScopesWithCommandFallback();
  useSignal(windowScope.nodeScopes);
  if (!open || !target) return null;
  const scope = target.nodeId === null ? own : windowScope.get(target.nodeId as BackendId);
  return <DebugBuildDialog key={target.environmentId} target={target} scope={scope ?? null} />;
}

/**
 * Debug: describe what is wrong (or what should be done), keep or drop the
 * window capture, and file one pipeline environment for it.
 *
 * The backend writes the ticket from these fields and attaches the
 * environment's details and agent transcript; this dialog only collects the
 * text and sends one request. The request id is kept across retries of the
 * same request, so a create whose answer was lost is not filed twice.
 */
export function DebugBuildDialog({
  target,
  scope,
}: {
  target: DebugBuildTarget;
  /** `null`: the environment's node is no longer in this window. */
  scope: NodeScope | null;
}) {
  const screenshot = useDebugBuildStore((state) => state.screenshot);
  const captureError = useDebugBuildStore((state) => state.captureError);
  const close = useDebugBuildStore((state) => state.close);
  const [problem, setProblem] = useState("");
  const [expectedResult, setExpectedResult] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ requestId: string; identity: string | null }>({
    requestId: createUuid(),
    identity: null,
  });
  const environmentName = scope
    ? scope.store(environmentStore).getState().getEnvironmentById(target.environmentId)?.name
    : undefined;
  const canSubmit = Boolean(scope) && problem.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!scope || !problem.trim() || submitting) return;
    const build = (requestId: string): CreateDebugBuildInput => ({
      environmentId: target.environmentId,
      problem: problem.trim(),
      ...(expectedResult.trim() ? { expectedResult: expectedResult.trim() } : {}),
      ...(includeScreenshot && screenshot ? { screenshot } : {}),
      requestId,
    });
    let request = build(attempt.current.requestId);
    const identity = debugBuildRequestIdentity(request);
    // A key an earlier attempt spent may only be reused for the same request.
    if (attempt.current.identity !== null && attempt.current.identity !== identity) {
      attempt.current.requestId = createUuid();
      request = build(attempt.current.requestId);
    }
    attempt.current.identity = identity;
    setSubmitting(true);
    try {
      const api = backendApiForScope(scope, createBuildPipelinesApi, { createDebugBuild });
      const result = await api.createDebugBuild(request);
      close();
      toast.success("Pipeline environment started", {
        description: "The ticket was added and its pipeline environment is being created.",
        action: {
          label: "Open",
          onClick: () => activateFeatureBuildEnvironment(result.projectId, result, scope),
        },
      });
    } catch (error) {
      log.error("build.start-failed", { error: formatLogError(error) });
      toast.error("Could not start the pipeline environment", { description: errorText(error) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !submitting) close();
      }}
    >
      <DialogContent size="2xl" data-testid="debug-build-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-4 text-muted-foreground" aria-hidden="true" />
            Debug this environment
          </DialogTitle>
          <DialogDescription>
            Starts one pipeline environment for what you describe. Its ticket is written from your
            text and carries the details and agent transcript of{" "}
            {environmentName ? <strong>{environmentName}</strong> : "this environment"}
            {screenshot ? ", with the screenshot if it is ticked." : "."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {scope ? null : (
            <p role="alert" className="text-sm text-destructive">
              The machine this environment is on is no longer shown in this window.
            </p>
          )}
          <div className="grid gap-2">
            {screenshot ? (
              <>
                <div
                  className={
                    includeScreenshot
                      ? "overflow-hidden rounded-md border border-border"
                      : "overflow-hidden rounded-md border border-border opacity-40"
                  }
                >
                  <img
                    src={`data:image/png;base64,${screenshot}`}
                    alt="The window when the debug button was pressed"
                    className="max-h-64 w-full object-contain object-top bg-background"
                    data-testid="debug-build-screenshot"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="debug-build-include-screenshot"
                    checked={includeScreenshot}
                    onCheckedChange={(checked) => setIncludeScreenshot(checked === true)}
                  />
                  <Label htmlFor="debug-build-include-screenshot" className="text-sm font-normal">
                    Attach this screenshot
                  </Label>
                </div>
              </>
            ) : (
              <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                <ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
                {captureError ?? "No screenshot was captured."}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="debug-build-problem">
              Problem / objective <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="debug-build-problem"
              autoFocus
              required
              rows={4}
              maxLength={MAX_DEBUG_BUILD_PROBLEM_LENGTH}
              placeholder="What is wrong, or what should be done?"
              value={problem}
              onChange={(event) => setProblem(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="debug-build-expected">
              Expected result <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="debug-build-expected"
              rows={3}
              maxLength={MAX_DEBUG_BUILD_EXPECTED_LENGTH}
              placeholder="What should happen instead, or how to tell it is done. One point per line becomes one acceptance criterion."
              value={expectedResult}
              onChange={(event) => setExpectedResult(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={submitting} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Create pipeline environment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
