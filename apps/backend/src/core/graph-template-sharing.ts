import {
  graphTemplateExportText,
  graphTemplateTrustState,
  type GraphTemplateCompileSummary,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import { diffRawLines } from "@orkestrator/protocol/node/change-tracking/raw-line-diff";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_SHARING_BOUNDS,
  createGraphTemplateBundle,
  graphBundleAuthorIssue,
  graphBundleSigningPayload,
  graphSharingKeyId,
  graphSharingPublicKeyBytes,
  graphTemplateBundleFileName,
  graphTemplateBundleText,
  graphTemplateCapabilitySummary,
  graphTemplateContentDigest,
  parseGraphShareText,
  type GraphProjectTemplateReview,
  type GraphProjectTemplateReviewDecision,
  type GraphProjectTemplateReviewItem,
  type GraphShareIntegrity,
  type GraphShareSigner,
  type GraphSharingKeys,
  type GraphTemplateReviewDiff,
  type GraphTemplateReviewDiffUnavailable,
  type GraphTemplateShareExport,
  type GraphTemplateShareImportResult,
  type GraphTemplateSharePreview,
} from "@orkestrator/protocol/graphs/sharing";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateService } from "./graph-template-service.js";
import {
  generateGraphSharingKeyPair,
  signGraphBundlePayload,
  verifyGraphBundleSignature,
} from "./graph-template-signing.js";
import type { PersistedGraphSharingKeys } from "./storage-graph-templates.js";
import type { GraphTemplatesStorage } from "./storage.js";

/**
 * Template sharing and the project template review flow (item 405): signed or
 * digest-checked share bundles, the installation's signing key and the keys
 * it trusts, and the review of untrusted and changed project templates with a
 * capability summary and a diff against the last approved copy. A
 * collaborator of {@link GraphTemplateService}, reached as `service.sharing`.
 *
 * Nothing here logs template content, bundle text, keys or signatures.
 */

export interface GraphTemplateSharingOptions {
  service: GraphTemplateService;
  storage: GraphTemplatesStorage;
  now: () => Date;
}

const MAX_KEY_LABEL = GRAPH_SHARING_BOUNDS.maxKeyLabelChars;

export class GraphTemplateSharing {
  constructor(private readonly options: GraphTemplateSharingOptions) {}

  private get storage(): GraphTemplatesStorage {
    return this.options.storage;
  }

  // ------------------------------------------------------------ export

  /**
   * A share bundle for `ref`. Signing uses this installation's key (created on
   * first use) and vouches for the content, so an untrusted or changed project
   * template is never signed.
   */
  async exportBundle(
    ref: GraphTemplateRef,
    input: { sign?: boolean; author?: string } = {},
  ): Promise<GraphTemplateShareExport> {
    if (input.author !== undefined) {
      const issue = graphBundleAuthorIssue(input.author);
      if (issue) throw new GraphTemplateError("invalid-request", issue);
    }
    const detail = await this.options.service.get(ref);
    if (input.sign && detail.summary.trust !== "trusted") {
      throw new GraphTemplateError(
        "untrusted",
        "Approve this project template before signing it: a signature vouches for its content",
      );
    }
    const bundle = createGraphTemplateBundle(detail.template, {
      exportedAt: this.options.now().toISOString(),
      ...(input.author !== undefined ? { author: input.author.trim() } : {}),
    });
    let keyId: string | undefined;
    if (input.sign) {
      const key = this.storage.ensureGraphSharingInstallationKey(() =>
        generateGraphSharingKeyPair(this.options.now()),
      );
      keyId = key.keyId;
      bundle.signature = {
        algorithm: "ed25519",
        publicKey: key.publicKey,
        keyId: key.keyId,
        value: signGraphBundlePayload(key, graphBundleSigningPayload(bundle, key.keyId)),
      };
    }
    const text = graphTemplateBundleText(bundle);
    if (Buffer.byteLength(text, "utf8") > GRAPH_SHARING_BOUNDS.maxBundleBytes) {
      throw new GraphTemplateError(
        "limit",
        `The bundle would be larger than ${GRAPH_SHARING_BOUNDS.maxBundleBytes} bytes`,
      );
    }
    return {
      fileName: graphTemplateBundleFileName(detail.template),
      text,
      digest: bundle.digest,
      contentDigest: bundle.contentDigest,
      signed: keyId !== undefined,
      ...(keyId !== undefined ? { keyId } : {}),
    };
  }

  // ------------------------------------------------------------ import

  /**
   * Checks share-import text and, only with `confirmDigest` equal to its
   * digest, saves it as a new user template. A tampered or malformed text is
   * refused; nothing is saved without the confirmation.
   */
  async importShared(
    text: string,
    input: { projectId?: string; confirmDigest?: string } = {},
  ): Promise<GraphTemplateShareImportResult> {
    const parsed = parseGraphShareText(text);
    if (!parsed.ok) {
      return {
        status: "refused",
        refused: parsed.refused,
        errors: parsed.errors,
        omittedErrors: parsed.omittedErrors,
      };
    }
    let template: GraphTemplateV1;
    let integrity: GraphShareIntegrity;
    let signer: GraphShareSigner | undefined;
    let digest: string;
    let contentDigest: string;
    let metadata: Pick<GraphTemplateSharePreview, "author" | "exportedAt"> = {};
    if (parsed.kind === "bundle") {
      const bundle = parsed.bundle;
      template = bundle.template;
      digest = bundle.digest;
      contentDigest = bundle.contentDigest;
      metadata = {
        ...(bundle.author !== undefined ? { author: bundle.author } : {}),
        exportedAt: bundle.exportedAt,
      };
      if (bundle.signature) {
        const signature = bundle.signature;
        const valid = verifyGraphBundleSignature(
          signature.publicKey,
          graphBundleSigningPayload(bundle, signature.keyId),
          signature.value,
        );
        if (!valid) {
          return {
            status: "refused",
            refused: "signature-invalid",
            errors: [
              {
                path: "signature.value",
                code: "signature_invalid",
                message:
                  "The signature does not match the bundle: it was changed after it was signed, or signed with another key",
              },
            ],
            omittedErrors: 0,
          };
        }
        signer = this.signerFor(signature.publicKey, signature.keyId);
        integrity = signer.label !== undefined ? "trusted-signer" : "untrusted-signer";
      } else {
        integrity = "unsigned";
      }
    } else {
      template = parsed.template;
      digest = graphTemplateDigest(template);
      contentDigest = graphTemplateContentDigest(template);
      integrity = "no-digest";
    }

    const service = this.options.service;
    const importId = await service.availableUserTemplateId(template.id);
    const candidate: GraphTemplateV1 = { ...structuredClone(template), id: importId, revision: 0 };
    delete candidate.engine;
    const compiled = await service.compile(
      { template: candidate },
      { ...(input.projectId ? { projectId: input.projectId } : {}), includePlan: true },
    );
    const preview: GraphTemplateSharePreview = {
      kind: parsed.kind,
      integrity,
      ...(signer ? { signer } : {}),
      digest,
      contentDigest,
      templateId: template.id,
      name: template.name,
      ...(template.description !== undefined ? { description: template.description } : {}),
      ...metadata,
      customTypes: template.types?.length ?? 0,
      ...(importId !== template.id ? { renameTo: importId } : {}),
      engineDropped: template.engine !== undefined,
      compile: compileSummaryOf(compiled),
      capabilities: graphTemplateCapabilitySummary(candidate, {
        plan: compiled.plan ?? null,
        diagnostics: compiled.diagnostics,
      }),
    };
    if (input.confirmDigest === undefined) return { status: "preview", preview };
    if (input.confirmDigest !== digest) {
      throw new GraphTemplateError(
        "digest-mismatch",
        "This is not the template you reviewed; review it again before importing",
      );
    }
    const imported = await service.importText(
      graphTemplateExportText(template),
      input.projectId ? { projectId: input.projectId } : {},
    );
    if (!imported.ok) {
      return {
        status: "refused",
        refused: "invalid-template",
        errors: imported.errors,
        omittedErrors: imported.omittedErrors,
      };
    }
    return {
      status: "imported",
      preview,
      detail: imported.detail,
      ...(imported.renamedFrom !== undefined ? { renamedFrom: imported.renamedFrom } : {}),
    };
  }

  private signerFor(publicKey: string, keyId: string): GraphShareSigner {
    const keys = this.storage.getGraphSharingKeys();
    const trusted = keys?.trusted.find(
      (entry) => entry.keyId === keyId && entry.publicKey === publicKey,
    );
    const own = keys?.installation?.publicKey === publicKey;
    return {
      keyId,
      publicKey,
      ...(trusted ? { label: trusted.label } : own ? { label: "This installation" } : {}),
      ...(own ? { own: true } : {}),
    };
  }

  // ------------------------------------------------------------ keys

  keys(input: { create?: boolean } = {}): GraphSharingKeys {
    if (input.create) {
      this.storage.ensureGraphSharingInstallationKey(() =>
        generateGraphSharingKeyPair(this.options.now()),
      );
    }
    return keysView(this.storage.getGraphSharingKeys());
  }

  /** Adds (or relabels) or removes a trusted signing key. */
  trustKey(input: {
    action: "add" | "remove";
    publicKey: string;
    label?: string;
  }): GraphSharingKeys {
    if (!graphSharingPublicKeyBytes(input.publicKey)) {
      throw new GraphTemplateError(
        "invalid-request",
        "publicKey must be a 32-byte Ed25519 key, base64url",
      );
    }
    const keyId = graphSharingKeyId(input.publicKey);
    if (input.action === "remove") {
      return keysView(this.storage.untrustGraphSharingKey(keyId).keys);
    }
    const label = input.label?.trim();
    if (!label || Array.from(label).length > MAX_KEY_LABEL || graphBundleAuthorIssue(label)) {
      throw new GraphTemplateError(
        "invalid-request",
        `label must be one line of at most ${MAX_KEY_LABEL} characters`,
      );
    }
    return keysView(
      this.storage.trustGraphSharingKey({
        keyId,
        publicKey: input.publicKey,
        label,
        addedAt: this.options.now().toISOString(),
      }),
    );
  }

  // ------------------------------------------------------------ review

  /**
   * Untrusted and changed project templates with what each would be allowed
   * to do and, for a changed one, a diff against the last approved copy.
   */
  async review(projectId: string, path?: string): Promise<GraphProjectTemplateReview> {
    const service = this.options.service;
    const list = await service.list({ projectId });
    const source = list.project;
    if (!source) throw new GraphTemplateError("not-found", `Project not found: ${projectId}`);
    const records = new Map(
      (this.storage.getGraphProjectSettings(projectId)?.trust ?? []).map((record) => [
        record.path,
        record,
      ]),
    );
    const approvals = this.storage.getGraphProjectApprovals(projectId);
    const items: GraphProjectTemplateReviewItem[] = [];
    for (const summary of list.templates) {
      if (summary.ref.scope !== "project" || summary.trust === "trusted") continue;
      if (path !== undefined && summary.ref.path !== path) continue;
      const ref = summary.ref;
      const detail = await service.get(ref);
      const compiled = await service.compile({ ref }, { includePlan: true });
      const record = summary.trust === "changed" ? records.get(ref.path) : undefined;
      const approved = approvals?.approved[ref.path];
      const rejected = approvals?.rejected[ref.path];
      const { diff, unavailable } = reviewDiff(
        summary,
        detail.template,
        record?.digest,
        approved?.digest === record?.digest ? approved : undefined,
      );
      items.push({
        ref,
        path: ref.path,
        templateId: summary.id,
        name: summary.name,
        ...(summary.description !== undefined ? { description: summary.description } : {}),
        trust: summary.trust,
        digest: summary.digest,
        ...(record ? { approvedDigest: record.digest, approvedAt: record.approvedAt } : {}),
        ...(rejected && rejected.digest === summary.digest
          ? { rejectedAt: rejected.rejectedAt }
          : {}),
        compile: summary.compile,
        capabilities: graphTemplateCapabilitySummary(detail.template, {
          plan: compiled.plan ?? null,
          diagnostics: compiled.diagnostics,
        }),
        diff,
        ...(unavailable ? { diffUnavailable: unavailable } : {}),
      });
    }
    items.sort(
      (a, b) =>
        Number(a.rejectedAt !== undefined) - Number(b.rejectedAt !== undefined) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return { projectId, source, items };
  }

  /**
   * Approve (109's approval at the reviewed digest, which resets trust and
   * keeps the approved copy) or reject (the template stays untrusted, the
   * rejected digest is recorded, an earlier approval is kept).
   */
  async decide(input: {
    projectId: string;
    path: string;
    digest: string;
    decision: "approve" | "reject";
  }): Promise<GraphProjectTemplateReviewDecision> {
    if (input.decision === "approve") {
      const result = await this.options.service.trust({
        projectId: input.projectId,
        path: input.path,
        action: "approve",
        digest: input.digest,
      });
      return {
        projectId: input.projectId,
        path: result.path,
        digest: input.digest,
        decision: "approve",
        trust: result.trust,
        decidedAt: result.approvedAt ?? this.options.now().toISOString(),
      };
    }
    const scan = await this.options.service.projectTemplates.scan(input.projectId);
    const file = scan.files.find((candidate) => candidate.path === input.path);
    if (!file) {
      throw new GraphTemplateError("not-found", `No project template at ${input.path}`);
    }
    if (file.digest !== input.digest) {
      throw new GraphTemplateError(
        "digest-mismatch",
        "The project template changed since you reviewed it; review it again",
      );
    }
    const rejectedAt = this.options.now().toISOString();
    this.storage.rejectGraphProjectTemplate(
      input.projectId,
      { path: file.path, digest: file.digest, rejectedAt },
      new Set(scan.files.map((candidate) => candidate.path)),
    );
    const record = this.storage
      .getGraphProjectSettings(input.projectId)
      ?.trust.find((candidate) => candidate.path === file.path);
    return {
      projectId: input.projectId,
      path: file.path,
      digest: file.digest,
      decision: "reject",
      trust: graphTemplateTrustState(record, file.digest),
      decidedAt: rejectedAt,
    };
  }
}

function keysView(keys: PersistedGraphSharingKeys | null): GraphSharingKeys {
  const installation = keys?.installation;
  return {
    // The private key stays here: only the public half is ever returned.
    installation: installation
      ? {
          keyId: installation.keyId,
          publicKey: installation.publicKey,
          createdAt: installation.createdAt,
        }
      : null,
    trusted: (keys?.trusted ?? []).map((entry) => ({ ...entry })),
  };
}

function compileSummaryOf(compiled: {
  ok: boolean;
  launchable: boolean;
  diagnostics: ReadonlyArray<{ severity: string }>;
  pendingAcknowledgements: readonly unknown[];
  planDigest: string | null;
  cost: {
    agentSessions: { best: number; worst: number };
    peakParallelism: number;
  } | null;
}): GraphTemplateCompileSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of compiled.diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else infos += 1;
  }
  return {
    ok: compiled.ok,
    launchable: compiled.launchable,
    errors,
    warnings,
    infos,
    pendingAcknowledgements: compiled.pendingAcknowledgements.length,
    planDigest: compiled.planDigest,
    cost: compiled.cost
      ? {
          agentSessions: { ...compiled.cost.agentSessions },
          peakParallelism: compiled.cost.peakParallelism,
        }
      : null,
  };
}

function reviewDiff(
  summary: GraphTemplateSummary,
  template: GraphTemplateV1,
  approvedDigest: string | undefined,
  approved: { text?: string; textOmitted?: "too-large" | "budget" } | undefined,
): { diff: GraphTemplateReviewDiff | null; unavailable?: GraphTemplateReviewDiffUnavailable } {
  if (summary.trust !== "changed" || approvedDigest === undefined) {
    return { diff: null, unavailable: "never-approved" };
  }
  if (approved?.text === undefined) {
    return {
      diff: null,
      unavailable: approved?.textOmitted === "too-large" ? "too-large" : "not-kept",
    };
  }
  const encoder = new TextEncoder();
  const result = diffRawLines(
    encoder.encode(approved.text),
    encoder.encode(graphTemplateExportText(template)),
    { maxOutputLines: GRAPH_SHARING_BOUNDS.maxDiffOutputLines },
  );
  switch (result.kind) {
    case "diff":
      return {
        diff: {
          fromDigest: approvedDigest,
          additions: result.additions,
          deletions: result.deletions,
          hunks: result.hunks,
          truncated: result.truncated,
        },
      };
    case "counts-only":
      return {
        diff: {
          fromDigest: approvedDigest,
          additions: result.additions,
          deletions: result.deletions,
          hunks: [],
          truncated: true,
        },
      };
    case "limit":
      return {
        diff: null,
        unavailable: result.reason === "input-bytes" ? "too-large" : result.reason,
      };
  }
}
