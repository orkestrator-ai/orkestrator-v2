import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  parseStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { Button } from "@/components/ui/button";
import { StructuredReviewReportView } from "./StructuredReviewReportView";

interface NativeStructuredReviewResultProps {
  enabled: boolean;
  sessionId?: string;
  resultKey?: string;
  isLoading: boolean;
  loadResult: () => Promise<StructuredOutputResult<unknown> | null>;
  onRetry: () => Promise<void> | void;
  pollIntervalMs?: number;
  maxResultPolls?: number;
}

/**
 * Provider-neutral normal-review result surface. It reads only the provider's
 * authoritative structured-output channel and validates the domain contract;
 * transcript text is never parsed as a fallback.
 */
export function NativeStructuredReviewResult({
  enabled,
  sessionId,
  resultKey,
  isLoading,
  loadResult,
  onRetry,
  pollIntervalMs = 1_000,
  maxResultPolls = 60,
}: NativeStructuredReviewResultProps) {
  const [report, setReport] = useState<StructuredReviewReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setReport(null);
    setFailure(null);
    setPollCount(0);
  }, [sessionId, resultKey, attempt]);

  useEffect(() => {
    if (!enabled || !sessionId || isLoading || retrying || report || failure) return;
    let cancelled = false;
    let timer: number | undefined;

    void loadResult().then((result) => {
      if (cancelled) return;
      if (!result) {
        if (pollCount >= maxResultPolls) {
          setFailure("The native agent completed without an inspectable structured result.");
        } else {
          timer = window.setTimeout(
            () => setPollCount((value) => value + 1),
            pollIntervalMs,
          );
        }
        return;
      }
      if (!result.ok) {
        setFailure(result.error.message);
        return;
      }
      try {
        setReport(parseStructuredReviewReport(result.value));
      } catch (error) {
        setFailure(
          error instanceof Error
            ? error.message
            : "The native agent returned an invalid structured review report.",
        );
      }
    }).catch((error) => {
      if (!cancelled) {
        setFailure(error instanceof Error ? error.message : "Failed to load structured review.");
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    enabled,
    failure,
    isLoading,
    loadResult,
    maxResultPolls,
    pollIntervalMs,
    pollCount,
    report,
    resultKey,
    retrying,
    sessionId,
  ]);

  const retry = useCallback(async () => {
    setRetrying(true);
    setReport(null);
    try {
      await onRetry();
      setFailure(null);
      setAttempt((value) => value + 1);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Failed to retry structured review.");
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  if (!enabled || !sessionId) return null;

  if (failure) {
    return (
      <section
        role="alert"
        className="mx-auto my-3 flex w-[min(48rem,calc(100%-1rem))] items-start gap-3 rounded-lg border border-red-500/35 bg-red-500/10 p-4"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-200">Structured review failed</p>
          <p className="mt-1 break-words text-xs text-red-200/80">{failure}</p>
        </div>
        <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>
          {retrying
            ? <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            : <RefreshCw className="mr-1.5 size-3.5" />}
          Retry
        </Button>
      </section>
    );
  }

  if (report) {
    return (
      <div className="mx-auto my-3 w-[min(56rem,calc(100%-1rem))]">
        <StructuredReviewReportView report={report} />
      </div>
    );
  }

  if (isLoading || pollCount > 0) {
    return (
      <div role="status" className="mx-auto my-3 flex w-fit items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Waiting for validated structured review…
      </div>
    );
  }

  return null;
}
