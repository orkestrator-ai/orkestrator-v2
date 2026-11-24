import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { linearFilePathSegment, linearFileUrl } from "@orkestrator/protocol/linear-files";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Download, File as FileIcon, Image as ImageIcon, Loader2 } from "lucide-react";
import type { Components, ExtraProps } from "react-markdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MarkdownLink, MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { openInBrowser } from "@/lib/backend";
import { isWkWebViewClient } from "@/lib/client-platform";
import type { ScopeBackend } from "@/lib/backend/scope-backend";
import type { LinearIssueFile } from "@/types/linear";

const log = createLogger("web.linear");

interface LoadedFiles {
  issueId: string;
  files: LinearIssueFile[];
}

export interface LinearIssueFilesState {
  files: readonly LinearIssueFile[];
  /** The file being opened, while its link is read. */
  opening: string | null;
  /** Reads an issue's files; replaces the ones of the issue shown before. */
  load(issueId: string): Promise<void>;
  open(url: string): Promise<void>;
}

const NO_FILES: readonly LinearIssueFile[] = [];

/**
 * The files of the issue on screen. Linear's file host refuses a plain link, so
 * the backend, which holds the key, reads ones that open for a few minutes.
 */
export function useLinearIssueFiles(
  backend: ScopeBackend,
  projectId: string | undefined,
): LinearIssueFilesState {
  const [loaded, setLoaded] = useState<LoadedFiles | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const requestRef = useRef(0);

  const read = useCallback(
    async (issueId: string): Promise<LoadedFiles> => {
      if (!projectId) throw new Error("This project has no Linear board linked.");
      const files = await backend.getLinearIssueFiles(projectId, issueId);
      return { issueId, files };
    },
    [backend, projectId],
  );

  const load = useCallback(
    async (issueId: string) => {
      const request = ++requestRef.current;
      setLoaded((current) => (current?.issueId === issueId ? current : { issueId, files: [] }));
      if (!projectId) return;
      try {
        const next = await read(issueId);
        if (requestRef.current === request) setLoaded(next);
      } catch (error) {
        // A node from before this command shows the issue without its files.
        if (incompatibility(error, "get_linear_issue_files")?.code === "unknown-command") return;
        log.warn("files.load-failed", { error: formatLogError(error) });
      }
    },
    [projectId, read],
  );

  const open = useCallback(
    async (url: string) => {
      const issueId = loaded?.issueId;
      let pending: Window | null = null;
      try {
        const browser = window.orkestratorGateway?.enabled && !window.orkestratorGateway.desktop;
        const webView = browser && isWkWebViewClient();
        if (browser && !webView) {
          pending = window.open("about:blank", "_blank");
          if (!pending)
            throw new Error("The browser blocked the download tab. Allow pop-ups and try again.");
          pending.opener = null;
        }

        let target = url;
        if (projectId && issueId) {
          setOpening(url);
          try {
            const next = await backend.getLinearIssueFiles(projectId, issueId, url);
            const signedUrl = next.find((file) => file.url === url)?.signedUrl;
            if (!signedUrl || linearFileUrl(signedUrl) !== url) {
              throw new Error("Linear did not return a download link for this file.");
            }
            target = signedUrl;
            setLoaded((current) =>
              current?.issueId === issueId
                ? {
                    ...current,
                    files: current.files.map((file) =>
                      file.url === url ? { ...file, signedUrl } : file,
                    ),
                  }
                : current,
            );
          } catch (error) {
            if (incompatibility(error, "get_linear_issue_files")?.code !== "unknown-command") {
              throw error;
            }
          }
        }
        if (pending) {
          if (pending.closed) throw new Error("The download tab was closed.");
          pending.location.replace(target);
        } else if (webView) {
          window.location.assign(target);
        } else {
          await openInBrowser(target);
        }
      } catch (error) {
        pending?.close();
        toast.error("Failed to download the Linear file", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setOpening((current) => (current === url ? null : current));
      }
    },
    [backend, loaded?.issueId, projectId],
  );

  const files = loaded?.files ?? NO_FILES;
  return useMemo(() => ({ files, opening, load, open }), [files, opening, load, open]);
}

const LinearFilesContext = createContext<LinearIssueFilesState | null>(null);
const InsideMarkdownLink = createContext(false);

function signedFileUrl(files: readonly LinearIssueFile[], url: string): string | undefined {
  const signedUrl = files.find((file) => file.url === url)?.signedUrl;
  return signedUrl && linearFileUrl(signedUrl) === url ? signedUrl : undefined;
}

export function LinearFilesProvider({
  files,
  children,
}: {
  files: LinearIssueFilesState;
  children: ReactNode;
}) {
  return <LinearFilesContext.Provider value={files}>{children}</LinearFilesContext.Provider>;
}

function LinearFileLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  const files = useContext(LinearFilesContext);
  const url = props.href ? linearFileUrl(props.href) : null;
  const children = (
    <InsideMarkdownLink.Provider value>{props.children}</InsideMarkdownLink.Provider>
  );
  if (!files || !url) return <MarkdownLink {...props}>{children}</MarkdownLink>;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    void files.open(url);
  };
  return (
    <a
      href={signedFileUrl(files.files, url) ?? props.href}
      className="cursor-pointer text-blue-300 hover:underline"
      onClick={open}
      onAuxClick={(event) => {
        if (event.button === 1) open(event);
      }}
    >
      {files.opening === url ? (
        <Loader2
          className="mr-1 inline size-3.5 animate-spin align-text-bottom"
          aria-hidden="true"
        />
      ) : (
        <Download className="mr-1 inline size-3.5 align-text-bottom" aria-hidden="true" />
      )}
      {children}
    </a>
  );
}

function LinearFileImage({
  src,
  alt,
  title,
  node: _node,
}: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
  const files = useContext(LinearFilesContext);
  const linked = useContext(InsideMarkdownLink);
  // The link that failed, so a newer link of the same image is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  const url = typeof src === "string" ? linearFileUrl(src) : null;
  if (!files || !url) return <img src={src} alt={alt} title={title} />;
  const label = alt || "image";
  const signedUrl = signedFileUrl(files.files, url);
  const image =
    signedUrl && signedUrl !== failed ? (
      <img
        src={signedUrl}
        alt={alt ?? ""}
        title={title}
        className="!my-0 max-h-96 max-w-full rounded-md border border-border/60"
        onError={() => setFailed(signedUrl)}
      />
    ) : (
      <>
        <ImageIcon className="inline size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </>
    );
  if (linked) return image;
  return (
    <button
      type="button"
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md text-blue-300 hover:underline"
      aria-label={`Open ${label}`}
      onClick={() => void files.open(url)}
    >
      {image}
    </button>
  );
}

/** Module-level so `MessageMarkdown`'s memo on `content` still holds. */
const LINEAR_MARKDOWN_COMPONENTS: Components = { a: LinearFileLink, img: LinearFileImage };

/** An issue's own Markdown: its Linear-hosted files open and its images show. */
export function LinearMarkdown({ content }: { content: string }) {
  return <MessageMarkdown content={content} components={LINEAR_MARKDOWN_COMPONENTS} />;
}

/** Every file the issue refers to, or nothing when it has none. */
export function LinearFileList() {
  const state = useContext(LinearFilesContext);
  if (!state || state.files.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Files">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Files</h3>
        <span className="text-xs text-muted-foreground">{state.files.length}</span>
      </div>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {state.files.map((file) => {
          const segment = linearFilePathSegment(file.url)
            .replace(/[\\/\x00-\x1f\x7f]/g, "-")
            .trim();
          const name =
            file.name ||
            (/\.[a-z\d]{1,10}$/i.test(segment) ? segment : `File ${segment || file.url}`);
          return (
            <li key={file.url} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={name}>
                {name}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                aria-label={`Download ${name}`}
                disabled={state.opening === file.url}
                onClick={() => void state.open(file.url)}
              >
                {state.opening === file.url ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">Download</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
