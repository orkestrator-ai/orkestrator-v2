import { useRef, useState } from "react";
import { Loader2, Send, TriangleAlert } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationDestinationOption,
  type WebAnnotationEvidenceSection,
  type WebAnnotationPreparation,
  type WebAnnotationRequest,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  classifyWebAnnotationError,
  describeWebAnnotationError,
  newWebAnnotationOperationId,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { DestinationPicker, destinationName } from "./DestinationPicker";
import { annotationTitle, formatBytes } from "./format";
import { useAnnotationPanel } from "./panel-context";

export interface ComposerItem {
  annotation: Pick<
    WebAnnotation,
    | "id"
    | "title"
    | "targetLabel"
    | "contentRevision"
    | "currentCaptureId"
    | "metadataRevision"
    | "defaultDestination"
  >;
  desiredOutcome?: string;
}

const SECTION_LABELS: Record<WebAnnotationEvidenceSection, string> = {
  intent: "your note",
  target: "target",
  page: "page",
  text: "visible text",
  geometry: "position",
  styles: "styles",
  attributes: "attributes",
  hierarchy: "ancestors",
  html: "HTML",
  image: "image",
  "legacy-reference": "imported reference",
  "thread-summary": "thread summary",
};

function sections(list: WebAnnotationEvidenceSection[]): string {
  return list.length ? list.map((section) => SECTION_LABELS[section]).join(", ") : "none";
}

const OPERATION_LABEL: Record<WebAnnotationRequestOperation, string> = {
  discuss: "Discuss",
  implement: "Request changes",
};

const HISTORICAL_CODES = new Set(["stale-capture", "legacy-evidence", "missing-evidence"]);

/**
 * Destination + brief preview + send. Discuss and Request changes are
 * separate actions; the preview shows exactly which agent receives which
 * trusted instruction and evidence. Send reuses one client-generated request
 * id across retries, so a lost response can never start a second turn.
 */
export function RequestComposer({
  items,
  initialOperation,
  onClose,
  onSent,
  reference,
}: {
  items: ComposerItem[];
  initialOperation?: WebAnnotationRequestOperation | null;
  onClose: () => void;
  onSent: (request: WebAnnotationRequest) => void;
  /**
   * `retargetOf`: send the same selections of a never-run request to another
   * session (the backend withdraws the old one in the same commit).
   * `followUpOf`: a follow-up of a settled request with `items`.
   */
  reference?: { retargetOf?: string; followUpOf?: string; previousTabId?: string } | null;
}) {
  const { environmentId, features, announce } = useAnnotationPanel();
  const [destination, setDestination] = useState<WebAnnotationDestinationOption | null>(null);
  const [instruction, setInstruction] = useState("");
  const [operation, setOperation] = useState<WebAnnotationRequestOperation | null>(
    initialOperation ?? null,
  );
  const [textOnly, setTextOnly] = useState(false);
  const [historical, setHistorical] = useState<Set<string>>(new Set());
  const [preparation, setPreparation] = useState<WebAnnotationPreparation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidated, setInvalidated] = useState<string | null>(null);
  const [deliveryUnknown, setDeliveryUnknown] = useState(false);
  // Stable until a send succeeds: a retry after a lost response re-sends it.
  const requestIdRef = useRef(newWebAnnotationOperationId("req"));
  const single = items.length === 1 ? items[0]!.annotation : null;

  const prepare = async (
    op: WebAnnotationRequestOperation,
    overrides: { textOnly?: boolean; historical?: Set<string> } = {},
  ) => {
    if (!destination) {
      setError("Choose an agent session first.");
      return;
    }
    setOperation(op);
    setPreparing(true);
    setError(null);
    setInvalidated(null);
    const useTextOnly = overrides.textOnly ?? textOnly;
    const allowHistorical = overrides.historical ?? historical;
    try {
      const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestPrepare, {
        environmentId,
        operation: op,
        destination: destination.destination,
        // A retarget reuses the old request's exact selections.
        annotations: reference?.retargetOf
          ? []
          : items.map((item) => ({
              annotationId: item.annotation.id,
              expectedContentRevision: item.annotation.contentRevision,
              expectedCaptureId: item.annotation.currentCaptureId,
              desiredOutcome: item.desiredOutcome?.trim() ? item.desiredOutcome.trim() : null,
              allowHistoricalEvidence: allowHistorical.has(item.annotation.id),
            })),
        instruction,
        ...(useTextOnly ? { textOnly: true } : {}),
        ...(reference?.retargetOf ? { retargetOf: reference.retargetOf } : {}),
        ...(reference?.followUpOf ? { followUpOf: reference.followUpOf } : {}),
      });
      setPreparation(result);
      announce(
        result.sendable
          ? `${OPERATION_LABEL[op]} request ready to send to ${destinationName(result.destination)}`
          : "The request cannot be sent yet; see the listed problems",
      );
    } catch (prepareError) {
      setPreparation(null);
      setError(describeWebAnnotationError(prepareError));
    } finally {
      setPreparing(false);
    }
  };

  const send = async () => {
    if (!preparation) return;
    setSending(true);
    setError(null);
    try {
      const { request } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestSend, {
        environmentId,
        preparationId: preparation.preparationId,
        requestId: requestIdRef.current,
        bodyHash: preparation.bodyHash,
      });
      setDeliveryUnknown(false);
      requestIdRef.current = newWebAnnotationOperationId("req");
      refreshWebAnnotations(environmentId, {
        annotationIds: items.map((item) => item.annotation.id),
        requestIds: [request.id],
      });
      announce(`Request sent to ${destinationName(request.destination)}`);
      onSent(request);
    } catch (sendError) {
      const kind = classifyWebAnnotationError(sendError);
      const message = describeWebAnnotationError(sendError);
      if (kind === "conflict" || /expired|invalid|mismatch|changed/i.test(message)) {
        // Specific mismatch; the draft (instruction, destination, items) stays.
        setInvalidated(message);
        setPreparation(null);
      } else {
        // Outcome unknown: the retry below reuses the same request id.
        setDeliveryUnknown(true);
        setError(message);
      }
      announce(`Send failed: ${message}`);
    } finally {
      setSending(false);
    }
  };

  const destinationLabel = destination
    ? destination.title
    : destinationName(single?.defaultDestination);
  // Discussion is enforced read-only only where the provider applies plan
  // mode per turn; everywhere else it is an instruction the agent may ignore.
  const advisory = destination ? !destination.planMode : false;
  const imagesBlocked = preparation?.issues.some((issue) => issue.code === "images-unsupported");
  const historicalIssues = preparation?.issues.filter(
    (issue) => issue.annotationId && HISTORICAL_CODES.has(issue.code),
  );

  return (
    <section
      aria-label="Ask an agent"
      className="space-y-2 rounded-md border border-border/70 p-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <DestinationPicker
        environmentId={environmentId}
        value={destination}
        onChange={(option) => {
          setDestination(option);
          setPreparation(null);
        }}
        fallback={reference?.retargetOf ? null : (single?.defaultDestination ?? null)}
        excludeTabId={reference?.previousTabId ?? null}
        defaultFor={
          single ? { annotationId: single.id, metadataRevision: single.metadataRevision } : null
        }
      />
      <Textarea
        value={instruction}
        onChange={(event) => {
          setInstruction(event.target.value.slice(0, WEB_ANNOTATION_LIMITS.instructionChars));
          setPreparation(null);
        }}
        rows={2}
        aria-label="Overall instruction"
        placeholder={
          single
            ? "Optional instruction. Leave empty to use your latest note."
            : "Optional overall instruction for all selected notes"
        }
        className="text-xs"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={operation === "discuss" ? "secondary" : "outline"}
          className="h-7 px-2 text-xs"
          disabled={!features.dispatch || preparing || !destination}
          onClick={() => void prepare("discuss")}
        >
          Discuss with {destinationLabel}
          {advisory ? " (advisory)" : ""}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={operation === "implement" ? "secondary" : "outline"}
          className="h-7 px-2 text-xs"
          disabled={!features.dispatch || preparing || !destination}
          onClick={() => void prepare("implement")}
        >
          Request changes from {destinationLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
      {reference?.retargetOf && (
        <p className="text-[11px] text-muted-foreground" data-composer-reference="retarget">
          Sends the same notes to the session you choose. The original request is withdrawn when
          this one is sent; it never ran.
        </p>
      )}
      {reference?.followUpOf && (
        <p className="text-[11px] text-muted-foreground" data-composer-reference="follow-up">
          Follow-up request: the agent receives the earlier result and discussion for context.
        </p>
      )}
      {advisory && (
        <p className="text-[11px] text-muted-foreground" data-discuss-advisory>
          This session cannot enforce read-only discussion; Discuss only asks it not to change
          files.
        </p>
      )}
      {!features.dispatch && (
        <p className="text-[11px] text-muted-foreground">
          This backend does not accept annotation requests yet.
        </p>
      )}
      {preparing && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> Preparing preview…
        </p>
      )}
      {invalidated && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]"
        >
          <p>The request changed after the preview: {invalidated}</p>
          <p className="text-muted-foreground">Your instruction and selection are kept.</p>
          {operation && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void prepare(operation)}
            >
              Prepare again
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      {preparation && (
        <div
          className="space-y-1.5 rounded border border-border/60 bg-muted/20 p-2 text-[11px]"
          data-preparation={preparation.preparationId}
        >
          <p>
            <span className="font-medium">{OPERATION_LABEL[preparation.operation]}</span> → sends to{" "}
            <span className="font-medium">{destinationName(preparation.destination)}</span> (
            {preparation.destination.agent})
          </p>
          <div>
            <p className="text-muted-foreground">Instruction the agent receives:</p>
            <p className="whitespace-pre-wrap break-words" data-trusted-instruction>
              {preparation.instruction}
            </p>
          </div>
          {preparation.operation === "discuss" && (
            <p className="text-muted-foreground">
              {preparation.readOnly === "plan-mode"
                ? "Discussion uses the agent's read-only plan mode for this turn."
                : "Discussion asks the agent not to change files; it keeps its existing permissions."}
            </p>
          )}
          <div>
            <p className="text-muted-foreground">Evidence:</p>
            <ul className="space-y-0.5" aria-label="Evidence manifest">
              {preparation.evidence.items.map((item) => {
                const source = items.find(
                  (candidate) => candidate.annotation.id === item.annotationId,
                );
                return (
                  <li key={item.annotationId}>
                    <span className="font-medium">
                      #{item.reference}{" "}
                      {source ? annotationTitle(source.annotation) : item.annotationId}
                    </span>
                    : included {sections(item.included)}
                    {item.omitted.length > 0 && `; omitted ${sections(item.omitted)}`}
                    {item.unavailable.length > 0 && `; unavailable ${sections(item.unavailable)}`}
                    {item.captureState !== "complete" && ` (${item.captureState} capture)`}
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground">
              {formatBytes(preparation.briefBytes)} brief · {preparation.evidence.imageCount} image
              {preparation.evidence.imageCount === 1 ? "" : "s"}
              {preparation.textOnly ? " · text only" : ""}
            </p>
          </div>
          {preparation.issues.length > 0 && (
            <ul className="space-y-0.5" aria-label="Problems">
              {preparation.issues.map((issue, index) => (
                <li
                  key={`${issue.code}-${issue.annotationId ?? ""}-${index}`}
                  className={issue.severity === "blocker" ? "text-destructive" : "text-amber-200"}
                >
                  <TriangleAlert className="mr-1 inline h-3 w-3" aria-hidden />
                  {issue.severity === "blocker" ? "Blocks sending: " : "Warning: "}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
          {imagesBlocked && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={textOnly}
                onChange={(event) => {
                  setTextOnly(event.target.checked);
                  void prepare(preparation.operation, { textOnly: event.target.checked });
                }}
              />
              Send text only — this session cannot receive images
            </label>
          )}
          {historicalIssues && historicalIssues.length > 0 && (
            <div className="space-y-0.5">
              {historicalIssues.map((issue) => (
                <label
                  key={`${issue.code}-${issue.annotationId}`}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="checkbox"
                    checked={historical.has(issue.annotationId!)}
                    onChange={(event) => {
                      const next = new Set(historical);
                      if (event.target.checked) next.add(issue.annotationId!);
                      else next.delete(issue.annotationId!);
                      setHistorical(next);
                      void prepare(preparation.operation, { historical: next });
                    }}
                  />
                  Send the older evidence for this note anyway
                </label>
              ))}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-muted-foreground">Show full brief</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-1.5 font-mono text-[10px]">
              {preparation.briefPreview}
            </pre>
          </details>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-2.5 text-xs"
              disabled={!preparation.sendable || sending}
              onClick={() => void send()}
            >
              {sending ? (
                <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Send className="h-3 w-3" aria-hidden />
              )}
              {deliveryUnknown ? "Retry send" : "Send"}
            </Button>
            {deliveryUnknown && (
              <span className="text-muted-foreground">
                Retrying uses the same request, so it cannot run twice.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
