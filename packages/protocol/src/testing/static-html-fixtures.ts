/**
 * Acceptance fixtures for the transcript's static HTML presentation. All data
 * is synthetic and labelled as such; none of it is product telemetry, and the
 * model names deliberately imply no real provider or price.
 */

interface FixtureSession {
  label: string;
  tokens: string;
  agentHours: number;
  elapsedHours: number;
  cost: number;
  /** Activity intervals in hours from the session's start. */
  intervals: ReadonlyArray<readonly [number, number]>;
}

export const ACTIVITY_REPORT_SESSIONS: readonly FixtureSession[] = [
  {
    label: "UI polish",
    tokens: "12.4M",
    agentHours: 0.8,
    elapsedHours: 1.3,
    cost: 18.2,
    intervals: [
      [0, 0.3],
      [0.5, 0.8],
      [1.1, 1.3],
    ],
  },
  {
    label: "Transcript rendering",
    tokens: "28.1M",
    agentHours: 1.9,
    elapsedHours: 2.4,
    cost: 42.6,
    intervals: [
      [0, 0.7],
      [0.8, 1.3],
      [1.5, 2.1],
      [2.3, 2.4],
    ],
  },
  {
    label: "Preview integration",
    tokens: "9.7M",
    agentHours: 0.6,
    elapsedHours: 1.1,
    cost: 15.4,
    intervals: [
      [0, 0.2],
      [0.4, 0.7],
      [1.0, 1.1],
    ],
  },
  {
    label: "Review and fixes",
    tokens: "17.5M",
    agentHours: 1.2,
    elapsedHours: 2.0,
    cost: 26.8,
    intervals: [
      [0, 0.4],
      [0.6, 0.9],
      [1.2, 1.5],
      [1.8, 2.0],
    ],
  },
];

export const ACTIVITY_REPORT_MODELS = [
  { label: "Model A", cost: 61.8, share: 60 },
  { label: "Model B", cost: 30.9, share: 30 },
  { label: "Model C", cost: 10.3, share: 10 },
] as const;

/** A shared scale, so every row's timeline is comparable. */
const TIMELINE_HOURS = 2.5;

function timeline(session: FixtureSession): string {
  const bars = session.intervals
    .map(
      ([start, end]) =>
        `<rect x="${(start * 100).toFixed(0)}" y="2" width="${((end - start) * 100).toFixed(0)}" height="10" rx="2" fill="var(--ork-chart-1, #2563eb)"/>`,
    )
    .join("");
  return `<svg class="timeline" viewBox="0 0 ${TIMELINE_HOURS * 100} 14" preserveAspectRatio="none" role="img" aria-label="${session.label}: ${session.agentHours} hours of agent time across ${session.elapsedHours} elapsed hours"><rect x="0" y="6" width="${(session.elapsedHours * 100).toFixed(0)}" height="2" fill="var(--ork-border, #d4d4d8)"/>${bars}</svg>`;
}

function modelBars(): string {
  const rows = ACTIVITY_REPORT_MODELS.map((model, index) => {
    const y = index * 30;
    return `<text x="0" y="${y + 15}" class="model-label">${model.label}</text><rect x="72" y="${y + 3}" width="${model.share * 3}" height="16" rx="3" fill="var(--ork-chart-${index + 1}, #2563eb)"/><text x="${72 + model.share * 3 + 8}" y="${y + 15}" class="model-value">$${model.cost.toFixed(2)} (${model.share}%)</text>`;
  }).join("");
  return `<svg class="models" viewBox="0 0 440 ${ACTIVITY_REPORT_MODELS.length * 30}" role="img" aria-label="Cost by model: Model A 60 percent, Model B 30 percent, Model C 10 percent">${rows}</svg>`;
}

/**
 * The reference dashboard: selectable labels, a per-row timeline on one time
 * scale, an inline SVG cost chart, a semantic table of every number, a native
 * disclosure, host theme tokens and a single-column narrow layout.
 */
export const ACTIVITY_REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<title>Agent activity and cost</title>
<style>
  body { color: var(--ork-foreground, #18181b); font-family: var(--ork-font-sans, system-ui, sans-serif); font-size: 14px; line-height: 1.45; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 18px 0 8px; }
  .note { color: var(--ork-muted-foreground, #52525b); font-size: 12px; margin: 0 0 12px; }
  .row { display: grid; grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr) 5rem 4.5rem; gap: 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--ork-border, #d4d4d8); }
  .session { font-weight: 600; }
  .timeline { display: block; width: 100%; height: 14px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .models { display: block; width: 100%; max-width: 440px; height: auto; }
  .model-label, .model-value { fill: var(--ork-foreground, #18181b); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 4px 8px 4px 0; border-top: 1px solid var(--ork-border, #d4d4d8); }
  details { margin-top: 12px; }
  @media (max-width: 560px) {
    .row { grid-template-columns: minmax(0, 1fr) auto auto; }
    .timeline { grid-column: 1 / -1; grid-row: 2; }
  }
</style>
</head>
<body>
<h1>Agent activity and cost</h1>
<p class="note">Synthetic data for acceptance testing; not product telemetry.</p>
<h2>Sessions</h2>
${ACTIVITY_REPORT_SESSIONS.map(
  (session) =>
    `<div class="row"><span class="session">${session.label}</span>${timeline(session)}<span class="num">${session.tokens}</span><span class="num">$${session.cost.toFixed(2)}</span></div>`,
).join("\n")}
<h2>Cost by model</h2>
${modelBars()}
<h2>Data</h2>
<table>
<thead><tr><th scope="col">Session</th><th scope="col">Tokens</th><th scope="col">Agent time</th><th scope="col">Elapsed</th><th scope="col">Cost</th></tr></thead>
<tbody>
${ACTIVITY_REPORT_SESSIONS.map(
  (session) =>
    `<tr><td>${session.label}</td><td>${session.tokens}</td><td>${session.agentHours.toFixed(1)} h</td><td>${session.elapsedHours.toFixed(1)} h</td><td>$${session.cost.toFixed(2)}</td></tr>`,
).join("\n")}
</tbody>
</table>
<details id="methodology">
<summary>Methodology and notes</summary>
<p>Timelines share one ${TIMELINE_HOURS} hour scale. Each bar is an interval of agent activity; the thin line is elapsed time. The model costs total $103.00.</p>
<p>Every value in this report is invented, and the model labels stand for no real model or price.</p>
</details>
</body>
</html>`;

/** Taller than the inline maximum: exercises the explicit overflow and expand policy. */
export const TALL_REPORT_HTML = `<!doctype html><html lang="en"><head><title>Long report</title></head><body><h1>Long report</h1>${Array.from(
  { length: 80 },
  (_, index) =>
    `<section><h2>Section ${index + 1}</h2><p>Synthetic paragraph ${index + 1}, long enough to take a line of its own in the report.</p></section>`,
).join("")}<p id="report-end">End of the long report</p></body></html>`;

/**
 * Authored against the light preview with hard-coded colours and no tokens. It
 * must stay readable under a dark application theme.
 */
export const PLAIN_REPORT_HTML = `<!doctype html><html lang="en"><head><title>Plain report</title><style>
  .card { background: #fff; border: 1px solid #ddd; padding: 12px; }
  .ink { color: #333; }
</style></head><body><h1>Plain report</h1><div class="card"><p id="inherited">Inherited text on a white card.</p><p id="ink" class="ink">Hard-coded dark text.</p></div></body></html>`;

/** Authored code and navigation that the presentation must neutralize. */
export const HOSTILE_REPORT_HTML = `<!doctype html><html><head>
<base href="https://hostile.invalid/">
<meta http-equiv="refresh" content="0; url=https://hostile.invalid/">
<link rel="stylesheet" href="https://hostile.invalid/x.css">
<script>window.__authored = true;</script>
<style>@import url(https://hostile.invalid/import.css); .bg { background: url(https://hostile.invalid/bg.png); }</style>
</head><body onload="window.__authored = true">
<h1 id="title">Hostile report</h1>
<div class="bg" style="background: url('https://hostile.invalid/inline.png')">Styled</div>
<img id="remote" src="https://hostile.invalid/remote.png" alt="">
<img id="beacon" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__authored = true">
<a id="js-link" href="javascript:window.__authored = true">Script link</a>
<a id="web-link" href="https://example.com/page" target="_blank">Web link</a>
<a id="download-link" href="https://example.com/file.zip" download>Download link</a>
<a id="fragment-link" href="#title">Fragment link</a>
<form id="form" action="https://hostile.invalid/post"><button id="submit" formaction="https://hostile.invalid/x">Send</button></form>
<iframe id="nested" srcdoc="<script>parent.__authored = true</script>"></iframe>
<object id="object" data="https://hostile.invalid/x"></object>
<embed id="embed" src="https://hostile.invalid/x">
<template id="tpl"><script>window.__authored = true;</script><img src="x" onerror="window.__authored = true"></template>
<details id="disclosure"><summary id="disclosure-summary">Open</summary><p>Inside</p></details>
<svg id="drawing" viewBox="0 0 10 10"><a id="svg-link" href="https://example.com/svg"><rect id="svg-rect" width="10" height="10"/></a><a id="svg-js" xlink:href="javascript:window.__authored = true"><text>x</text></a><script>window.__authored = true;</script></svg>
</body></html>`;
