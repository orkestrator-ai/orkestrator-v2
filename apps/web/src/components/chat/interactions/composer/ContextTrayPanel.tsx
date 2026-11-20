import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import {
  CONTEXT_LIMITS,
  describeAnchorLocation,
  type ContextItem,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { useNodeScope } from "@/lib/node-scope/providers";
import { contextTrayKey, contextTrayStore, useContextTrayStore } from "@/stores/contextTrayStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { newIdempotencyKey } from "@/lib/chat/rich-interactions";
import { richInteractionErrorMessage } from "@/lib/backend/rich-interactions";
import { cn } from "@/lib/utils";
import { ContentRefPreview, RefChip, inputClass, textareaClass } from "../shared";
import { ImageRegionPicker, newContextItemId } from "./composer-shared";

const EMPTY: ContextItem[] = [];

/**
 * Feature 15: the visible context tray. The person collects files, excerpts,
 * artifact revisions and selections, previews exactly what will be attached,
 * removes or annotates items, and sends one request. The tray describes the
 * material attached to this request, not the provider's whole context.
 */
export function ContextTrayPanel({
  environmentId,
  logicalSessionKey,
  onSent,
}: {
  environmentId: string;
  logicalSessionKey: string;
  onSent?: () => void;
}) {
  const key = contextTrayKey(environmentId, logicalSessionKey);
  const items = useContextTrayStore((state) => state.trays.get(key) ?? EMPTY);
  const scope = useNodeScope();
  const backend = useScopeBackend();
  const [prompt, setPrompt] = useState("");
  const [path, setPath] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendKey, setSendKey] = useState<string | null>(null);
  const tray = () => scope.store(contextTrayStore).getState();
  const included = items.filter((item) => item.included);
  const excerptChars = included.reduce((n, item) => n + (item.excerpt?.length ?? 0), 0);
  const tabId = logicalSessionKey.slice(logicalSessionKey.indexOf(":") + 1);
  const overBudget = excerptChars > CONTEXT_LIMITS.totalExcerptChars;

  const send = async () => {
    setSending(true);
    setError(null);
    // One key per deliberate send, reused if this attempt has to be retried.
    const idempotencyKey = sendKey ?? newIdempotencyKey();
    setSendKey(idempotencyKey);
    try {
      await backend.composeRichInteraction({
        environmentId,
        tabId,
        kind: "context-packet",
        title: prompt.trim().slice(0, 80) || `Request with ${included.length} reference(s)`,
        spec: { items },
        actionId: "send",
        idempotencyKey,
        result: { prompt: prompt.trim() },
      });
      tray().clear(key);
      setPrompt("");
      setSendKey(null);
      onSent?.();
    } catch (cause) {
      setError(`${richInteractionErrorMessage(cause)} Your tray is kept; it is safe to retry.`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" aria-label="Context tray">
      <p className="text-xs text-muted-foreground">
        References attached to your next request. Collecting and previewing is local; nothing is
        sent until you press Send. This is what you attach, not everything the agent can see.
      </p>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          The tray is empty. Add a file or excerpt below, or use “Add to request” on a deliverable.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li
            key={item.itemId}
            className={cn(
              "rounded border px-2 py-1.5",
              item.included ? "border-border/60" : "border-dashed border-border/40 opacity-60",
            )}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                aria-label={`Include ${item.label}`}
                checked={item.included}
                onChange={(e) => tray().update(key, item.itemId, { included: e.target.checked })}
              />
              <span className="font-medium">{item.label}</span>
              <RefChip reference={item.source} />
              {item.location ? (
                <span className="text-muted-foreground">
                  {describeAnchorLocation(item.location)}
                </span>
              ) : null}
              {item.source.kind === "file" ? (
                <select
                  className="rounded border border-border/60 bg-transparent px-1 text-[11px]"
                  aria-label={`Version of ${item.label}`}
                  value={item.freeze}
                  onChange={(e) =>
                    tray().update(key, item.itemId, {
                      freeze: e.target.value as ContextItem["freeze"],
                    })
                  }
                >
                  <option value="latest">Latest file when sent</option>
                  <option value="frozen" disabled={!item.excerpt}>
                    Reviewed excerpt
                  </option>
                </select>
              ) : null}
              <div className="ml-auto flex gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Preview ${item.label}`}
                  onClick={() => setPreview(preview === item.itemId ? null : item.itemId)}
                >
                  <span className="text-[10px]">{preview === item.itemId ? "Hide" : "View"}</span>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Move ${item.label} up`}
                  disabled={index === 0}
                  onClick={() => tray().move(key, item.itemId, -1)}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Move ${item.label} down`}
                  disabled={index === items.length - 1}
                  onClick={() => tray().move(key, item.itemId, 1)}
                >
                  <ArrowDown className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Remove ${item.label}`}
                  onClick={() => tray().remove(key, item.itemId)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
            <input
              className={cn(inputClass, "mt-1 py-1 text-xs")}
              placeholder="Note (optional), e.g. “the regression”"
              aria-label={`Note for ${item.label}`}
              value={item.userNote ?? ""}
              onChange={(e) => tray().update(key, item.itemId, { userNote: e.target.value })}
            />
            {preview === item.itemId ? (
              <div className="mt-2">
                {item.excerpt ? (
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">
                    {item.excerpt}
                  </pre>
                ) : item.source.kind === "workspace-image" ? (
                  <>
                    <p className="mb-1 text-[11px] text-muted-foreground">
                      Drag on the image (or type percentages) to point at a region.
                    </p>
                    <ImageRegionPicker
                      initial={
                        item.location?.kind === "image-region" ? item.location.rect : undefined
                      }
                      onChange={(rect) =>
                        tray().update(
                          key,
                          item.itemId,
                          rect
                            ? { location: { kind: "image-region", rect } }
                            : { location: undefined },
                        )
                      }
                    >
                      <ContentRefPreview reference={item.source} description={item.label} />
                    </ImageRegionPicker>
                  </>
                ) : (
                  <ContentRefPreview reference={item.source} description={item.label} compact />
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded border border-border/60 p-2">
        <div className="flex gap-2">
          <input
            className={cn(inputClass, "font-mono text-xs")}
            placeholder="Add a workspace file, e.g. src/app.ts"
            aria-label="Workspace file path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!path.trim() || /(^|\/)\.\.(\/|$)/u.test(path)}
            onClick={() => {
              const clean = path.trim();
              const image = /\.(png|jpe?g|gif|webp|svg)$/iu.test(clean);
              tray().add(key, {
                itemId: newContextItemId(),
                kind: image ? "image" : "file",
                source: image
                  ? { kind: "workspace-image", path: clean }
                  : { kind: "file", path: clean, live: true },
                label: clean.split("/").pop() ?? clean,
                included: true,
                freeze: image ? "frozen" : "latest",
              });
              setPath("");
            }}
          >
            Add file
          </Button>
        </div>
        <div className="flex gap-2">
          <textarea
            className={cn(textareaClass, "text-xs")}
            rows={2}
            placeholder="Paste an excerpt to quote (kept exactly as reviewed)"
            aria-label="Excerpt"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!excerpt.trim() || excerpt.length > CONTEXT_LIMITS.excerptChars}
            onClick={() => {
              tray().add(key, {
                itemId: newContextItemId(),
                kind: "excerpt",
                source: { kind: "inline", label: "Pasted excerpt" },
                excerpt: excerpt.trim(),
                label: `Excerpt: ${excerpt.trim().slice(0, 40)}`,
                included: true,
                freeze: "frozen",
              });
              setExcerpt("");
            }}
          >
            Add excerpt
          </Button>
        </div>
      </div>
      <textarea
        className={textareaClass}
        rows={3}
        placeholder="Your request"
        aria-label="Request"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("text-muted-foreground", overBudget && "text-failure")}>
          {included.length} of {items.length} included · {excerptChars.toLocaleString()} of{" "}
          {CONTEXT_LIMITS.totalExcerptChars.toLocaleString()} excerpt characters
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={sending || included.length === 0 || overBudget}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send with these references"}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-failure" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
