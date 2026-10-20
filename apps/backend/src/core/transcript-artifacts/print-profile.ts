/**
 * The fixed print profile under which the isolated preview worker prints an
 * HTML artifact revision to PDF, and its identity.
 *
 * Nothing in the profile comes from artifact content: the paper is one of two
 * fixed sizes chosen by the host UI, margins/scale/backgrounds/motion are
 * constants, and the theme and viewport are those of the revision's own
 * verified preview receipt. A stored PDF records the profile identity, so a
 * different profile (or a new profile version) is a different representation.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { PDF_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactPrintPaper } from "@orkestrator/protocol/transcript-artifact-commands";
import type { ArtifactPreviewProfile } from "@orkestrator/protocol/transcript-artifacts";

export const ARTIFACT_PRINT_PROFILE_VERSION = "artifact-print-profile:v1";

/** Playwright `page.pdf` paper formats for the two fixed papers. */
export const PRINT_PAPER_FORMAT: Readonly<Record<ArtifactPrintPaper, "A4" | "Letter">> = {
  a4: "A4",
  letter: "Letter",
};

export interface ArtifactPrintProfile {
  version: typeof ARTIFACT_PRINT_PROFILE_VERSION;
  paper: ArtifactPrintPaper;
  /** Backgrounds are always printed so the PDF matches the verified preview. */
  printBackground: true;
  marginMm: number;
  scale: 1;
  reducedMotion: "reduce";
  /** Taken from the revision's verified preview profile. */
  theme: "light" | "dark";
  viewport: { width: number; height: number };
  maxPages: number;
  maxBytes: number;
}

export function isArtifactPrintPaper(value: unknown): value is ArtifactPrintPaper {
  return value === "a4" || value === "letter";
}

export function artifactPrintProfile(
  paper: ArtifactPrintPaper,
  preview: ArtifactPreviewProfile,
): ArtifactPrintProfile {
  return {
    version: ARTIFACT_PRINT_PROFILE_VERSION,
    paper,
    printBackground: true,
    marginMm: PDF_POLICY.printMarginMm,
    scale: 1,
    reducedMotion: "reduce",
    theme: preview.theme,
    viewport: { width: preview.viewport.width, height: preview.viewport.height },
    maxPages: PDF_POLICY.maxPages,
    maxBytes: PDF_POLICY.maxBytes,
  };
}

/** SHA-256 over the profile's canonical JSON (domain-separated). */
export function printProfileIdentity(profile: ArtifactPrintProfile): string {
  return createHash("sha256")
    .update(`artifact-print-profile\0${canonicalJson(profile)}`)
    .digest("hex");
}

/**
 * Number of pages in a PDF Chromium printed. Skia writes one uncompressed
 * `/Type /Page` dictionary per page (the page tree itself is `/Pages`).
 */
export function countPrintedPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/** `%PDF-` within the first KiB, as the PDF specification allows. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.includes("%PDF-", 0, "latin1");
}
