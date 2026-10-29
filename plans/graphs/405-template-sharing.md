---
id: 405
title: "Template sharing"
phase: 4
plan: "Phase 4"
status: done
depends_on: [109]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 405 · Template sharing

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D2
- **Depends on:** [109](109-template-storage-and-trust.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Templates can be shared safely between people and projects.

## Work

- [x] Write the design note in this file's Notes (written and built on 2026-10-29).
- [x] Get the design note agreed by the user. (Approved as built by the maintainer on 2026-10-29: [D22](../composable-graphs.md#decisions).)
- [x] Export and import with signatures or digests.
- [x] A review flow for project templates.
- [x] Designer: Share… (export as bundle), Import bundle… (check, then import at the shown digest) and a Review panel with Approve and Reject.

## Tests

- [x] A tampered shared template is refused.
- [x] Round trip: export, preview, confirmed import; confirming another digest saves nothing.
- [x] A changed project template shows a diff against the approved copy, and approving resets trust; rejecting keeps the earlier approval.
- [x] Bounds: trusted keys, approved copies per template and per project, bundle size, node lists.
- [x] Component tests for the review panel, the share dialogs and the designer entry points.

## Done when

- [x] Template sharing ships.

## Notes

**2026-10-29 · Design note (written first, per the user's standing Phase 4
instruction: design, then build, reviewed in the pull request).**

*Problem.* Item 109 gives three scopes and digest trust for project templates,
and plain JSON import/export. Nothing proves that a template someone hands you is
the one they sent, and a project template that changed shows only "Changed",
with no way to see what changed or what the template would be allowed to do
(report §6.9: treat project templates like an untrusted MCP config).

*Share bundle format, `orkestrator.graph-bundle` version 1.* One JSON document,
written as canonical pretty text (sorted keys, two-space indent, trailing
newline, like 109's export) to `<id>.graph-bundle.json`:

```json
{
  "format": "orkestrator.graph-bundle",
  "formatVersion": 1,
  "template": { "...": "the GraphTemplateV1, custom types inline in template.types" },
  "digest": "<graphTemplateDigest(template)>",
  "contentDigest": "<sha256 of graphTemplateExportText(template)>",
  "exportedAt": "2026-10-29T12:00:00.000Z",
  "author": "optional display name, at most 120 characters, one line",
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<base64url, 32 bytes>",
    "keyId": "<first 32 hex of sha256(public key)>",
    "value": "<base64url, 64 bytes>"
  }
}
```

- Custom types travel inside the template (`template.types`): a template is
  self-contained, so the bundle needs no separate type list.
- Two digests. `digest` is 109's `graphTemplateDigest` (the identity trust,
  confirmation and the library show; it leaves out `layout`). `contentDigest`
  covers the whole canonical template text, layout included, so no byte of the
  template can change unnoticed.
- Metadata is bounded and content-free: `author` (≤ 120 characters, no control
  characters) and `exportedAt`. Nothing else; unknown fields are refused, and so
  are duplicate keys (strict parse, as for templates). A bundle is at most 2 MiB
  of text; the template inside keeps its own 1 MiB guard.
- The signature signs a fixed payload:
  `orkestrator.graph-bundle/1\n` + canonical JSON of `{author?, contentDigest,
  digest, exportedAt, keyId, templateId}`. Both digests are inside it, so a
  valid signature binds every byte of the template and the metadata.

*Decision 1: integrity and authenticity.*
- Option A, digests only, plus an explicit confirmation showing the digest and
  a capability summary. Pros: no key management, nothing secret stored. Cons: a
  digest in the same file only catches corruption and careless edits; anyone
  who edits the template can recompute it, so it says nothing about who made
  it unless the digest is compared out of band.
- Option B (recommended), digests always plus an optional Ed25519 signature.
  Each installation gets one keypair, created on first use (`node:crypto` in
  the backend only; the browser never sees the private key). The user keeps a
  list of trusted public keys (at most 64, each with a label). Pros: a bundle
  from a colleague whose key you trusted is verifiably theirs and unmodified;
  the digest still works for unsigned bundles; the cost is one small store row
  and two commands. Cons: key distribution is manual (copy the public key or
  fingerprint), and there is no revocation beyond removing a key from your own
  list.
- Option C, a central signing service or certificates. Pros: real identity.
  Cons: infrastructure and outward-facing services this product does not have.

*Decision 2: what a bad, unsigned or unknown-signer bundle does.*
- A tampered bundle (either digest does not match the template, or a signature
  that does not verify) is **refused**: nothing is saved, and the result says
  which check failed (`digest-mismatch`, `content-digest-mismatch`,
  `signature-invalid`). Importing it "as untrusted" was rejected: a user
  template is trusted the moment it exists (D2), so there is no untrusted
  landing place, and a file that fails its own checks has no claim to one.
- An unsigned bundle, a bundle signed by a key not on the trusted list, and a
  plain template pasted into the bundle dialog are **importable after explicit
  confirmation**. The preview says which of these it is (`unsigned`,
  `untrusted-signer` with the fingerprint, `trusted-signer` with the label,
  `no-digest` for a plain template) and the user can trust an unknown signer's
  key from the preview.

*Decision 3: how an imported template lands.*
- Option A, a new "untrusted user template" state. Cons: user templates are
  trusted by definition in D2 and 109; a second trust state for them touches the
  library, launch, designer and run surfaces.
- Option B (recommended), a two-step import: `graph_template_share_import`
  without `confirmDigest` returns a preview (integrity, signer, digest, compile
  counts, capability summary, taint warnings) and saves nothing; the same call
  with `confirmDigest` equal to the bundle's `digest` saves it as a new user
  template (a taken id gets a suffix; `engine` is dropped, as for 109's
  import). The confirmation is the approval, exactly like approving a project
  template's digest. A different `confirmDigest` is refused (`digest-mismatch`).
  The project ceiling (D18) still caps the template whenever it is compiled for
  a project.
- 109's plain "Import JSON…" stays as it is (an escape hatch for your own JSON,
  P1.10); sharing goes through the bundle dialog, which also accepts plain
  template JSON and shows the same preview.

*Decision 4: signing what you export.* Signing is optional per export. A
project template is signed only while it is trusted (a signature vouches for
content; vouching for unapproved repository content is refused with
`untrusted`). Built-ins and user templates can always be signed.

*Decision 5: the project template review flow.*
- On approval, the backend keeps the approved canonical text beside the trust
  record (collection `approvals` in `graph-templates`, one row per project;
  at most 256 KiB per template and 4 MiB per project: past that the record keeps
  the digest but drops the text, oldest approvals first, and the diff says
  "not kept"). Revoking an approval drops its copy; project removal drops the
  row.
- `graph_project_template_review {projectId, path?}` lists project templates
  that are untrusted or changed, each with its digest, compile counts, a
  capability summary (agent nodes per profile, capabilities added with
  `allow`, nodes that write the workspace, Orkestrator tool groups, system
  actions and whether each has side effects, capabilities the ceiling removed,
  taint paths and taint warnings), and for a changed template a line diff of the
  canonical text against the last approved copy (bounded: 400 rendered lines,
  the shared raw-line diff's edit-distance and time budgets).
- The designer gets a **Review** panel (a dialog from the header, with a count
  of templates needing review) listing those templates; each shows the summary
  and diff with **Approve** and **Reject**. Approve is 109's approval at the
  reviewed digest (so it refuses a file that changed while the panel was open)
  and resets trust. Reject keeps the template untrusted, records the rejected
  digest so the panel files it under "Rejected" (a new digest asks again), and
  keeps any earlier approval, so reverting the file to the approved content is
  trusted again. Option considered: Reject revokes the earlier approval. Cons:
  it destroys the diff baseline and the user's earlier decision for no gain,
  because a changed template is already unlaunchable.

*Logging and bounds.* Nothing logs template content, bundle text, keys or
signatures. Every list is bounded: trusted keys 64, approved texts as above,
rejections one per existing path, review items by the project's file bound
(64), node names per summary line 32, taint warnings 20.

**2026-10-29 · Built.** Shapes in `@orkestrator/protocol/graphs/sharing` (new export
`./graphs/sharing`, browser-safe; `library.ts` gained `graphCanonicalJsonText`).
- Protocol: `GRAPH_BUNDLE_FORMAT`, `GRAPH_SHARING_BOUNDS`, `GraphTemplateBundleV1`,
  `createGraphTemplateBundle`, `graphTemplateBundleText`, `graphTemplateBundleFileName`,
  `graphTemplateContentDigest`, `graphBundleSigningPayload`, `parseGraphShareText` /
  `validateGraphTemplateBundle` (refusal codes `GRAPH_SHARE_REFUSAL_CODES`: `invalid-bundle`,
  `invalid-template`, `digest-mismatch`, `content-digest-mismatch`, `signature-invalid`),
  `graphSharingKeyId` / `graphSharingFingerprint`, base64url helpers, and
  `graphTemplateCapabilitySummary(template, {plan, diagnostics})` → `GraphTemplateCapabilitySummary`.
- Backend: `graph-template-signing.ts` (Ed25519 via `node:crypto`, keys as raw base64url JWK
  members), `graph-template-sharing.ts` (`GraphTemplateSharing`, reached as
  `GraphTemplateService.sharing`; the service gained `availableUserTemplateId`, and its approval now
  stores the approved canonical text), `commands-registry-graph-sharing.ts` (registered from
  `registerGraphTemplateCommands`, a separate file to keep the shared registry edit to one line).
  Store: `graph-templates` gained collections `sharing` (row `keys`) and `approvals` (one row per
  project: `{approved: {path: {digest, approvedAt, text?, textOmitted?}}, rejected: {path: {digest,
  rejectedAt}}}`); repository methods `getGraphProjectApprovals`, `rejectGraphProjectTemplate`,
  `getGraphSharingKeys`, `ensureGraphSharingInstallationKey`, `trustGraphSharingKey`,
  `untrustGraphSharingKey`; `approveGraphProjectTemplate` takes the approved text; revoking drops
  the copy; `deleteGraphProjectSettings` drops the approvals row.
- Commands (refusals throw `GraphTemplateError`, codes from 109):
  `graph_template_share_export {ref, sign?, author?}` → `{fileName, text, digest, contentDigest,
  signed, keyId?}` (signing an untrusted project template → `untrusted`);
  `graph_template_share_import {text, projectId?, confirmDigest?}` → `{status: "refused", refused,
  errors, omittedErrors} | {status: "preview", preview} | {status: "imported", preview, detail,
  renamedFrom?}` (a `confirmDigest` that is not the bundle's → `digest-mismatch`);
  `graph_sharing_keys {create?}` / `graph_sharing_key_trust {action: "add"|"remove", publicKey,
  label?}` → `{installation: {keyId, publicKey, createdAt} | null, trusted: [{keyId, publicKey,
  label, addedAt}]}`; `graph_project_template_review {projectId, path?}` → `{projectId, source,
  items: [{ref, path, templateId, name, trust, digest, approvedDigest?, approvedAt?, rejectedAt?,
  compile, capabilities, diff: {fromDigest, additions, deletions, hunks, truncated} | null,
  diffUnavailable?}]}`; `graph_project_template_review_decide {projectId, path, digest, decision}`
  → `{projectId, path, digest, decision, trust, decidedAt}`.
- Web: wrappers in `apps/web/src/lib/backend/graph-template-sharing.ts`
  (`exportGraphTemplateBundle`, `importGraphTemplateBundle`, `getGraphSharingKeys`,
  `setGraphSharingKeyTrust`, `reviewGraphProjectTemplates`, `decideGraphProjectTemplateReview`);
  designer components `GraphShareDialogs.tsx`, `GraphTemplateReviewPanel.tsx`,
  `GraphCapabilitySummary.tsx`; header buttons Share…, Import bundle…, Review (N) (N = project
  templates not trusted, from the library list).
- Diffs reuse the shared raw-line diff (`@orkestrator/protocol/node/change-tracking/raw-line-diff`)
  in the backend over 109's canonical export text, capped at 400 rendered lines.
- Not done here: no real-stack browser pass of the new dialogs (the brief does not ask for one,
  and the existing Playwright spec `e2e/agent-testing/graph-designer.spec.ts` is unchanged); a
  user template does not record that it came from a bundle or who signed it.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Design note, bundle format and guard, Ed25519 signing, share export/import, trusted keys, project template review with diffs, designer dialogs and review panel, tests; complete; awaiting PR.
- 2026-10-29 · coordinator · Split the design-note box: written, but agreement is still pending (the user's answer was never received; the build went ahead on the coordinator's recommended default). · Awaiting the user's review.
- 2026-10-29 · coordinator · The maintainer approved the design note as built (D22). · Awaiting PR.
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
