/**
 * Page-side frame helpers for the anchor kit (todo 0047 task 5, same-origin
 * iframes).
 *
 * Like `browserPreviewAnchorKit`, `browserPreviewFrameKit` is serialized with
 * `Function.prototype.toString` and evaluated inside the preview page, so it
 * must stay self-contained: no imports, no module-level references. The anchor
 * kit receives it as its argument (`browserPreviewAnchorKitSource`).
 *
 * Reach is the browser's own: a frame's document is read only through
 * `contentDocument`, which the browser leaves null for a cross-origin or
 * sandboxed (opaque-origin) frame, and the kit additionally refuses a document
 * whose origin differs from the top document's. Nothing here posts messages to
 * a frame, runs script in one, or relaxes the preview's sandbox; a frame the
 * page's own scripts cannot read stays out of reach.
 */
export function browserPreviewFrameKit() {
  // `WEB_ANNOTATION_MAX_FRAME_DEPTH` in the protocol (this kit cannot import).
  const MAX_FRAME_DEPTH = 4;
  // `WEB_ANNOTATION_FRAME_DOCUMENT_PATH_CHARS` in the protocol.
  const DOCUMENT_PATH_CHARS = 500;
  /** Frame elements the resolver matched, so the pin layer can watch them navigate. */
  const MAX_SEEN_FRAMES = 16;
  /** A path segment that looks like a token or an opaque id, never copied into an anchor. */
  const OPAQUE_SEGMENT = /^[A-Za-z0-9+_=.%-]{32,}$/;

  type Rect = { x: number; y: number; width: number; height: number };
  type Box = Rect & { scaleX: number; scaleY: number };

  const isElement = (node: unknown): node is Element =>
    Boolean(node) && (node as Node).nodeType === 1;
  const isFrameElement = (node: unknown): node is HTMLIFrameElement =>
    isElement(node) && (node.tagName === "IFRAME" || node.tagName === "FRAME");

  /**
   * The document of a same-origin frame, or null: cross-origin and sandboxed
   * frames (whose `contentDocument` the browser withholds), a document with a
   * different or opaque origin, and a frame with no document yet.
   */
  const reachableDocument = (frame: Element): Document | null => {
    if (!isFrameElement(frame)) return null;
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument ?? null;
    } catch {
      return null;
    }
    if (!doc || doc.nodeType !== 9 || !doc.documentElement) return null;
    try {
      // The window's own origin: `location.origin` reads "null" for an
      // `about:srcdoc` document even when it inherits its parent's origin.
      const view = doc.defaultView as (Window & { origin?: string }) | null;
      const origin = view?.origin ?? "";
      const top = (window as Window & { origin?: string }).origin ?? window.location.origin;
      if (!origin || origin === "null" || origin !== top) return null;
    } catch {
      return null;
    }
    return doc;
  };

  /** The frame element showing `doc`, or null for the top document or a discarded one. */
  const frameElementOf = (doc: Document): Element | null => {
    if (doc === document) return null;
    try {
      const frame = doc.defaultView?.frameElement ?? null;
      return isFrameElement(frame) ? frame : null;
    } catch {
      return null;
    }
  };

  /**
   * Whether `doc` is the top document or is still shown, through a chain of
   * connected same-origin frames, inside it. A frame that navigated leaves its
   * old document detached from every frame, so an element in it is no longer
   * on the page even though `isConnected` (relative to that old document)
   * still reads true.
   */
  const isLiveDocument = (doc: Document | null | undefined): boolean => {
    let current = doc ?? null;
    for (let depth = 0; current && depth <= MAX_FRAME_DEPTH + 1; depth += 1) {
      if (current === document) return true;
      const frame = frameElementOf(current);
      if (!frame || !frame.isConnected || reachableDocument(frame) !== current) return false;
      current = frame.ownerDocument;
    }
    return false;
  };

  /** Frames between `doc` and the top document; -1 when the chain is broken or too deep. */
  const frameDepthOf = (doc: Document): number => {
    let current: Document = doc;
    for (let depth = 0; depth <= MAX_FRAME_DEPTH + 1; depth += 1) {
      if (current === document) return depth;
      const frame = frameElementOf(current);
      if (!frame) return -1;
      current = frame.ownerDocument;
    }
    return -1;
  };

  /**
   * The frame document's sanitized display path for an anchor: the path of its http(s) URL
   * (never the origin, query or fragment; opaque segments read `:opaque`), or
   * `about:srcdoc` / `about:blank`. Null for anything else, which leaves the
   * target unsupported.
   */
  const documentPathOf = (doc: Document): string | null => {
    let href = "";
    try {
      href = String(doc.defaultView?.location?.href ?? doc.URL ?? "");
    } catch {
      return null;
    }
    if (href.length > 16_384) return null;
    if (href === "about:srcdoc" || href === "about:blank") return href;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname
      .split("/")
      .map((segment) => (OPAQUE_SEGMENT.test(segment) ? ":opaque" : segment));
    const path = segments.join("/") || "/";
    if (
      path.length > DOCUMENT_PATH_CHARS ||
      !path.startsWith("/") ||
      /[\\?#\u0000-\u001f\u007f]/.test(path) ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    return path;
  };

  // Synchronous SHA-256 keeps the serialized resolver synchronous. Hash the full
  // URL, never serialize its query or opaque path segments. Cache per Document.
  const identities = new WeakMap<Document, string>();
  const documentIdentityOf = (doc: Document): string => {
    const cached = identities.get(doc);
    // Read each time: history.replaceState can change a live document's URL.
    const href = String(doc.defaultView?.location.href ?? doc.URL);
    if (cached?.startsWith(href + "\n")) return cached.slice(href.length + 1);
    const bytes = new TextEncoder().encode(href);
    const length = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(length);
    data.set(bytes);
    data[bytes.length] = 128;
    const view = new DataView(data.buffer);
    view.setUint32(length - 4, bytes.length * 8);
    const primes: number[] = [];
    for (let n = 2; primes.length < 64; n++) {
      if (!primes.some((p) => n % p === 0)) primes.push(n);
    }
    const words = new Uint32Array(64);
    const hash = primes.slice(0, 8).map((p) => (Math.sqrt(p) * 2 ** 32) >>> 0);
    const constants = primes.map((p) => (Math.cbrt(p) * 2 ** 32) >>> 0);
    const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < length; offset += 64) {
      for (let i = 0; i < 64; i++) {
        if (i < 16) words[i] = view.getUint32(offset + i * 4);
        else {
          const x = words[i - 15]!,
            y = words[i - 2]!;
          words[i] =
            words[i - 16]! +
            (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
            words[i - 7]! +
            (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
        }
      }
      let [a, b, c, d, e, f, g, h] = hash as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      for (let i = 0; i < 64; i++) {
        const t =
          (h +
            (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
            ((e & f) ^ (~e & g)) +
            constants[i]! +
            words[i]!) |
          0;
        const u =
          ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t) | 0;
        d = c;
        c = b;
        b = a;
        a = (t + u) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => {
        hash[i] = (hash[i]! + v) >>> 0;
      });
    }
    const identity = hash.map((v) => v.toString(16).padStart(8, "0")).join("");
    identities.set(doc, href + "\n" + identity);
    return identity;
  };

  const finiteOr = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;

  /**
   * A frame's content box in its parent's viewport (inside its border and
   * padding), with the scale a CSS transform or zoom applies to its contents.
   */
  const frameBox = (frame: Element): Box | null => {
    try {
      const outer = frame.getBoundingClientRect();
      const element = frame as HTMLElement;
      const view = frame.ownerDocument?.defaultView ?? window;
      const style = view.getComputedStyle(frame);
      const scaleX = element.offsetWidth > 0 ? outer.width / element.offsetWidth : 1;
      const scaleY = element.offsetHeight > 0 ? outer.height / element.offsetHeight : 1;
      const paddingLeft = finiteOr(parseFloat(style.paddingLeft), 0);
      const paddingTop = finiteOr(parseFloat(style.paddingTop), 0);
      const paddingRight = finiteOr(parseFloat(style.paddingRight), 0);
      const paddingBottom = finiteOr(parseFloat(style.paddingBottom), 0);
      const box = {
        x: outer.left + (element.clientLeft + paddingLeft) * scaleX,
        y: outer.top + (element.clientTop + paddingTop) * scaleY,
        width: Math.max(0, element.clientWidth - paddingLeft - paddingRight) * scaleX,
        height: Math.max(0, element.clientHeight - paddingTop - paddingBottom) * scaleY,
        scaleX: finiteOr(scaleX, 1),
        scaleY: finiteOr(scaleY, 1),
      };
      return [box.x, box.y, box.width, box.height].every(Number.isFinite) ? box : null;
    } catch {
      return null;
    }
  };

  /**
   * A rectangle in `doc`'s viewport, mapped into the top document's viewport
   * through each frame and clipped to each frame's content box, because
   * content a frame scrolls or clips away is not on screen. A broken chain or
   * a frame without a box gives an empty rectangle at the origin.
   */
  const toTopRect = (rect: Rect, doc: Document): Rect => {
    let current = rect;
    let currentDoc = doc;
    for (let depth = 0; currentDoc !== document; depth += 1) {
      const frame = depth <= MAX_FRAME_DEPTH ? frameElementOf(currentDoc) : null;
      const box = frame ? frameBox(frame) : null;
      if (!frame || !box) return { x: 0, y: 0, width: 0, height: 0 };
      const x = box.x + current.x * box.scaleX;
      const y = box.y + current.y * box.scaleY;
      const left = Math.min(Math.max(x, box.x), box.x + box.width);
      const top = Math.min(Math.max(y, box.y), box.y + box.height);
      const right = Math.min(Math.max(x + current.width * box.scaleX, box.x), box.x + box.width);
      const bottom = Math.min(Math.max(y + current.height * box.scaleY, box.y), box.y + box.height);
      current = {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
      currentDoc = frame.ownerDocument;
    }
    return current;
  };

  /** A point in the parent's viewport, in `frame`'s own viewport; null outside its content box. */
  const framePoint = (frame: Element, x: number, y: number): { x: number; y: number } | null => {
    const box = frameBox(frame);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    if (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) return null;
    return { x: (x - box.x) / box.scaleX, y: (y - box.y) / box.scaleY };
  };

  let seenFrames: Element[] = [];
  const noteFrame = (frame: Element): void => {
    if (seenFrames.length < MAX_SEEN_FRAMES && !seenFrames.includes(frame)) seenFrames.push(frame);
  };

  return {
    MAX_FRAME_DEPTH,
    isFrameElement,
    reachableDocument,
    frameElementOf,
    isLiveDocument,
    frameDepthOf,
    documentPathOf,
    documentIdentityOf,
    toTopRect,
    framePoint,
    noteFrame,
    /** Frame elements matched since the last reset, at most 16. */
    framesSeen: (): Element[] => seenFrames.slice(),
    resetSeen: (): void => {
      seenFrames = [];
    },
  };
}

export type BrowserPreviewFrameKit = ReturnType<typeof browserPreviewFrameKit>;
