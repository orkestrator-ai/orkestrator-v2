/**
 * Deterministic HTML for the annotation fixture. Pure function of the route
 * and fixture state so tests can assert exact markup, and so a source change
 * in `content.ts` is visible in the rendered page without a build step.
 */
import { FEATURE_TOGGLES, PLANS, SETTINGS_COPY, type FixturePlan } from "./content";
import {
  ADVERSARIAL_STRINGS,
  FIXTURE_MARKER,
  LATE_FONT_DELAY_MS,
  ROUTE_VARIANTS,
  SYNTHETIC_SECRETS,
  TEST_IDS,
} from "./fixture-data";

export interface FixtureState {
  /** Order of the pricing cards. */
  cardOrder: "default" | "reversed";
  /** Order of the repeated feature-toggle rows. */
  featureOrder: "default" | "reversed";
  /** Render the Team card twice (duplicate stable ids). */
  duplicateTeam: boolean;
  /** The fixture sign-in expired: `/account` redirects to `/sign-in`. */
  sessionExpired: boolean;
  /** Advances on every server-side change; exposed to the page. */
  generation: number;
}

export const INITIAL_STATE: Readonly<FixtureState> = Object.freeze({
  cardOrder: "default",
  featureOrder: "default",
  duplicateTeam: false,
  sessionExpired: false,
  generation: 1,
});

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.45 sans-serif;color:#1f2933;background:#f7f7f5}
header{padding:12px 20px;background:#243b53;color:#fff}
nav{white-space:nowrap;overflow-x:auto}
nav a{color:#d9e2ec;margin-right:18px}
main{padding:20px;max-width:1180px}
section{margin:0 0 24px;padding:16px;background:#fff;border:1px solid #d9e2ec;border-radius:6px}
.row{display:flex;gap:12px;align-items:center;margin:8px 0}
.row label{width:140px}
.actions{display:flex;gap:8px;justify-content:flex-end}
.plans{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:16px}
.plan{border:1px solid #bcccdc;border-radius:6px;padding:14px}
.plan .price{font-size:26px;font-weight:700}
.features li{display:flex;justify-content:space-between;align-items:center;margin:4px 0;max-width:420px}
.wide{overflow-x:auto}
.wide table{min-width:960px;border-collapse:collapse}
.wide td,.wide th{border:1px solid #d9e2ec;padding:6px 10px}
.long{max-width:720px}
[data-sensitive]{background:#fff4e5;padding:6px}
@media (max-width:600px){.plans{grid-template-columns:1fr}}
@keyframes fixture-slide{from{transform:translateX(0)}to{transform:translateX(160px)}}
.animated{display:inline-block;padding:8px 12px;background:#d9e2ec;animation:fixture-slide 0.9s ease-in-out infinite alternate}
.late-font{font-family:"Fixture Late",sans-serif;font-size:20px;line-height:28px;margin:0 0 12px}
.fonts-settled .late-font{font-size:40px;line-height:72px}
.spacer{height:2400px;border-left:4px dotted #d9e2ec}
dialog{border:1px solid #829ab1;border-radius:6px;padding:16px}
`;

function layout(title: string, route: string, state: FixtureState, body: string): string {
  const links = [
    ["Settings", ROUTE_VARIANTS.settings],
    ["Pricing", ROUTE_VARIANTS.pricing],
    ["Team annual", ROUTE_VARIANTS.pricingTeamAnnual],
    ["Starter monthly", ROUTE_VARIANTS.pricingStarterMonthly],
    ["Billing (hash route)", ROUTE_VARIANTS.hashSettingsBilling],
    ["Profile link with token", ROUTE_VARIANTS.tokenBearingSettings],
  ]
    .map(([label, href]) => `<a href="${escapeHtml(href!)}">${escapeHtml(label!)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body data-fixture-marker="${FIXTURE_MARKER}" data-route="${escapeHtml(route)}" data-generation="${state.generation}">
<header><strong>Fixture Cloud</strong><nav aria-label="Primary">${links}</nav></header>
<main id="app">${body}</main>
<script>${pageScript(state)}</script>
</body></html>`;
}

function settingsSection(): string {
  const c = SETTINGS_COPY;
  return `<section aria-labelledby="settings-heading">
<h1 id="settings-heading">${escapeHtml(c.heading)}</h1>
<form id="settings-form" onsubmit="return false">
  <fieldset><legend>Profile</legend>
    <div class="row"><label for="display-name">${escapeHtml(c.displayNameLabel)}</label>
      <input id="display-name" name="displayName" value="${escapeHtml(c.displayName)}"></div>
    <div class="row"><label for="contact-email">${escapeHtml(c.emailLabel)}</label>
      <input id="contact-email" name="email" type="email" value="${escapeHtml(c.email)}"></div>
  </fieldset>
  <fieldset><legend>Security</legend>
    <div class="row"><label for="settings-password">Password</label>
      <input id="settings-password" data-testid="${TEST_IDS.passwordField}" type="password" autocomplete="current-password" value="${escapeHtml(SYNTHETIC_SECRETS.password)}"></div>
    <div class="row"><label for="otp">One-time code</label>
      <input id="otp" autocomplete="one-time-code" value="${escapeHtml(SYNTHETIC_SECRETS.oneTimeCode)}"></div>
    <div class="row" data-sensitive data-testid="${TEST_IDS.tokenPanel}"><span>API token</span>
      <code>${escapeHtml(SYNTHETIC_SECRETS.apiToken)}</code></div>
  </fieldset>
  <div class="actions" role="group" data-testid="actions">
    <button type="button" data-testid="cancel-settings">${escapeHtml(c.cancel)}</button>
    <button type="submit" data-testid="${TEST_IDS.saveSettings}">${escapeHtml(c.save)}</button>
  </div>
</form>
</section>`;
}

function featureSection(state: FixtureState): string {
  const features =
    state.featureOrder === "reversed" ? [...FEATURE_TOGGLES].reverse() : FEATURE_TOGGLES;
  // Deliberately no ids or test ids: identical buttons that only their row
  // label distinguishes, to catch a pin that silently moves to a neighbour.
  const rows = features
    .map(
      (feature) =>
        `<li><span class="feature-name">${escapeHtml(feature)}</span><button type="button">Enable</button></li>`,
    )
    .join("");
  return `<section aria-label="Features"><h2>Features</h2>
<ul class="features" data-testid="${TEST_IDS.featureList}">${rows}</ul></section>`;
}

function adversarialSection(): string {
  const a = ADVERSARIAL_STRINGS;
  const payload = a.forgedJson.replace(/</g, "\\u003c");
  return `<section data-testid="${TEST_IDS.adversarialPanel}" aria-label="${escapeHtml(a.fakeMarker)}" title="${escapeHtml(a.ignoreInstructions)}" data-note="${escapeHtml(a.forgedJson)}">
<h2>Customer feedback</h2>
<p class="feedback-marker">${escapeHtml(a.fakeMarker)}</p>
<p class="feedback-fence">${escapeHtml(a.fenceBreak)}</p>
<p class="feedback-ignore">${escapeHtml(a.ignoreInstructions)}</p>
<p class="feedback-slash">${escapeHtml(a.slashCommand)}</p>
<p class="feedback-role">${escapeHtml(a.roleSpoof)}</p>
<pre class="feedback-json">${escapeHtml(a.forgedJson)}</pre>
<script type="application/json" id="forged-annotation-payload">${payload}</script>
</section>`;
}

function planCard(plan: FixturePlan, copy = 0): string {
  const features = plan.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("");
  return `<article class="plan" data-testid="plan-card-${plan.id}" data-copy="${copy}" aria-label="${escapeHtml(plan.name)} plan">
<h3>${escapeHtml(plan.name)}</h3>
<div class="price">${escapeHtml(plan.price)}</div><div class="cadence">${escapeHtml(plan.cadence)}</div>
<ul>${features}</ul>
<button type="button" data-testid="plan-cta-${plan.id}">${escapeHtml(plan.cta)}</button>
</article>`;
}

function pricingSection(state: FixtureState): string {
  const ordered = state.cardOrder === "reversed" ? [...PLANS].reverse() : PLANS;
  const cards: string[] = [];
  for (const plan of ordered) {
    cards.push(planCard(plan));
    if (state.duplicateTeam && plan.id === "team") cards.push(planCard(plan, 1));
  }
  return `<section aria-labelledby="pricing-heading">
<h1 id="pricing-heading">Pricing</h1>
<p class="plan-hint" data-plan-hint></p>
<div class="plans" data-testid="plan-grid">${cards.join("")}</div></section>`;
}

function comparisonSection(): string {
  const columns = ["Capability", ...PLANS.map((plan) => plan.name), "Notes", "Region"];
  const rows = ["Projects", "History", "Support", "SSO", "Audit log", "Residency"]
    .map(
      (row, index) =>
        `<tr><th scope="row">${row}</th>${PLANS.map((plan) => `<td>${escapeHtml(plan.name)} ${row.toLowerCase()} tier ${index + 1}</td>`).join("")}<td>Synthetic note ${index + 1}</td><td>eu-fixture-${index + 1}</td></tr>`,
    )
    .join("");
  return `<section aria-label="Comparison"><h2>Compare plans</h2>
<div class="wide"><table data-testid="${TEST_IDS.wideTable}"><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** About 6 KB of deterministic prose for long-text selection and budget checks. */
export function longText(): string {
  const sentences: string[] = [];
  for (let index = 1; index <= 48; index += 1) {
    sentences.push(
      `Clause ${index}: the fixture workspace retains synthetic usage records for review cycle ${index}, and every figure on this page is generated for testing only.`,
    );
  }
  return sentences.join(" ");
}

function embeddedSections(): string {
  const frame = escapeHtml(
    `<!doctype html><body style="font:13px sans-serif"><p>Embedded billing widget</p><button type="button" id="frame-action">Update card</button></body>`,
  );
  return `<section aria-label="Embedded regions"><h2>Embedded regions</h2>
<iframe title="Embedded billing widget" data-testid="billing-iframe" width="320" height="90" srcdoc="${frame}"></iframe>
<fixture-shadow-card data-testid="shadow-card"></fixture-shadow-card>
<canvas id="usage-chart" data-testid="usage-chart" width="320" height="120" aria-label="Usage chart"></canvas>
</section>
<section aria-label="Terms"><h2>Terms</h2><p class="long" data-testid="long-text">${escapeHtml(longText())}</p></section>`;
}

/** An infinite CSS animation (it moves its own box) beside copy that never moves. */
function motionSection(): string {
  return `<section aria-label="Motion"><h1>Release banner</h1>
<p><span class="animated" data-testid="${TEST_IDS.animatedBanner}">New: synthetic release banner</span></p>
<p data-testid="${TEST_IDS.staticCopy}">This paragraph does not move while the banner animates.</p></section>`;
}

/** Bounded delay for the late font route and its font request. */
export function lateFontDelay(url: URL): number {
  const value = Number(url.searchParams.get("delay") ?? LATE_FONT_DELAY_MS.default);
  if (!Number.isFinite(value)) return LATE_FONT_DELAY_MS.default;
  return Math.min(LATE_FONT_DELAY_MS.max, Math.max(0, Math.round(value)));
}

/**
 * A heading in a web font the server answers late. Whatever the font request
 * returns, the page applies the font's larger metrics once it settles, so the
 * target below shifts down exactly when a swapped-in web font would move it.
 * `document.fonts.ready` stays pending until then. The font load holds the
 * load event unless `lazy` starts it 200 ms after load, as a script font
 * loader does.
 */
function lateFontSection(delay: number, lazy: boolean): string {
  return `<section aria-label="Late font"><h1 class="late-font" data-testid="${TEST_IDS.lateFontHeading}">Fixture Cloud release notes</h1>
<p>Text below the heading moves when the font arrives.</p>
<button type="button" data-testid="${TEST_IDS.fontShiftTarget}">Read the release notes</button></section>
<script>(() => {
  const settled = () => document.body.classList.add("fonts-settled");
  if (typeof FontFace !== "function" || !document.fonts) { settled(); return; }
  // A fresh URL per load: Chromium reuses a failed font for a repeated URL.
  const face = new FontFace("Fixture Late", "url(/__fixture/font?delay=${delay}&load=" + Date.now() + Math.random() + ")");
  const start = () => {
    document.fonts.add(face);
    face.load().catch(() => null).finally(settled);
  };
  ${lazy ? 'window.addEventListener("load", () => setTimeout(start, 200));' : "start();"}
})();</script>`;
}

/** A target inside a modal dialog (closed unless `?open=1`), and one far below the fold. */
function dialogSection(open: boolean): string {
  return `<section aria-label="Dialogs"><h1>Workspace settings</h1>
<button type="button" data-testid="${TEST_IDS.openDialog}">Edit workspace name</button>
<dialog data-testid="${TEST_IDS.dialog}" aria-label="Edit workspace name">
  <form method="dialog"><p>Rename the synthetic workspace.</p>
  <div class="actions"><button value="cancel">Cancel</button>
  <button value="confirm" data-testid="${TEST_IDS.dialogConfirm}">Save workspace name</button></div></form>
</dialog></section>
<div class="spacer" aria-hidden="true"></div>
<footer><p data-testid="${TEST_IDS.offscreenFooter}">Synthetic footer far below the fold</p></footer>
<script>(() => {
  const dialog = document.querySelector('[data-testid="${TEST_IDS.dialog}"]');
  const open = () => { if (!dialog.open) dialog.showModal(); };
  document.querySelector('[data-testid="${TEST_IDS.openDialog}"]').addEventListener("click", open);
  ${open ? "open();" : ""}
})();</script>`;
}

function accountSection(): string {
  return `<section aria-label="Account"><h1>Account</h1>
<p data-testid="${TEST_IDS.accountPlan}">Team plan for the synthetic workspace, renews on 1 December.</p></section>`;
}

function signInSection(next: string): string {
  return `<section aria-label="Sign in"><h1>Your session expired</h1>
<form onsubmit="return false"><input type="hidden" name="next" value="${escapeHtml(next)}">
<div class="row"><label for="sign-in-email">Email</label><input id="sign-in-email" type="email" value=""></div>
<button type="submit" data-testid="${TEST_IDS.signInSubmit}">Sign in again</button></form></section>`;
}

function hotReloadControl(): string {
  return `<section aria-label="Fixture controls"><button type="button" data-testid="${TEST_IDS.hotReload}">Simulate hot reload</button></section>`;
}

/**
 * In-page hooks. They mutate the DOM the way a dev-server hot reload does,
 * without the server or a navigation, so pin behaviour can be exercised.
 */
function pageScript(state: FixtureState): string {
  return `(() => {
  const hooks = {
    generation: ${state.generation},
    replacements: 0,
    reverse(selector) {
      const parent = document.querySelector(selector);
      if (!parent) return false;
      Array.from(parent.children).reverse().forEach((child) => parent.appendChild(child));
      return true;
    },
    reorderCards() { return hooks.reverse('[data-testid="plan-grid"]'); },
    reorderFeatures() { return hooks.reverse('[data-testid="${TEST_IDS.featureList}"]'); },
    duplicateTeamCard() {
      const card = document.querySelector('[data-testid="${TEST_IDS.teamCard}"]');
      if (!card) return false;
      const copy = card.cloneNode(true);
      copy.setAttribute("data-copy", "1");
      card.after(copy);
      return true;
    },
    removeTeamCard() {
      document.querySelectorAll('[data-testid="${TEST_IDS.teamCard}"]').forEach((card) => card.remove());
      return true;
    },
    replaceSaveButton() {
      const button = document.querySelector('[data-testid="${TEST_IDS.saveSettings}"]');
      if (!button) return false;
      button.replaceWith(button.cloneNode(true));
      hooks.replacements += 1;
      return true;
    },
    /** Replace every node under <main> with a fresh copy of the same markup. */
    hotReload() {
      const main = document.getElementById("app");
      main.innerHTML = main.innerHTML;
      hooks.replacements += 1;
      hooks.install();
      return true;
    },
    install() {
      const reload = document.querySelector('[data-testid="${TEST_IDS.hotReload}"]');
      if (reload) reload.addEventListener("click", () => hooks.hotReload());
      const hint = document.querySelector("[data-plan-hint]");
      if (hint) {
        const plan = new URLSearchParams(location.search).get("plan");
        const cadence = location.hash.replace(/^#/, "");
        hint.textContent = plan ? "Highlighted plan: " + plan + (cadence ? " (" + cadence + ")" : "") : "";
      }
      const hashView = document.querySelector("[data-hash-view]");
      if (hashView) hashView.textContent = location.hash.startsWith("#/") ? "Hash route " + location.hash.slice(1) : "No hash route";
      const canvas = document.getElementById("usage-chart");
      if (canvas && canvas.getContext) {
        const context = canvas.getContext("2d");
        if (context) {
          context.fillStyle = "#f0f4f8"; context.fillRect(0, 0, 320, 120);
          [40, 70, 55, 95, 30, 80].forEach((height, index) => {
            context.fillStyle = "#486581"; context.fillRect(20 + index * 48, 110 - height, 32, height);
          });
        }
      }
    },
  };
  if (!customElements.get("fixture-shadow-card")) {
    customElements.define("fixture-shadow-card", class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<div style="padding:8px;border:1px dashed #829ab1"><p>Shadow root card</p><button type="button">Shadow action</button></div>';
      }
    });
  }
  window.__annotationFixture = hooks;
  window.addEventListener("hashchange", () => hooks.install());
  hooks.install();
})();`;
}

/** Render a route. Unknown paths return null (the server answers 404). */
export function renderPage(url: URL, state: FixtureState): { title: string; html: string } | null {
  const variant = url.searchParams.get("variant");
  const effective: FixtureState = {
    ...state,
    ...(variant === "reordered" ? { cardOrder: "reversed", featureOrder: "reversed" } : {}),
    ...(variant === "duplicate" ? { duplicateTeam: true } : {}),
  };
  const route = `${url.pathname}${url.search}`;
  if (url.pathname === "/settings") {
    const title = "Settings — Fixture Cloud";
    const body = `${settingsSection()}${featureSection(effective)}${adversarialSection()}${hotReloadControl()}`;
    return { title, html: layout(title, route, effective, body) };
  }
  if (url.pathname === "/pricing") {
    const title = "Pricing — Fixture Cloud";
    const body = `${pricingSection(effective)}${comparisonSection()}${embeddedSections()}${hotReloadControl()}`;
    return { title, html: layout(title, route, effective, body) };
  }
  if (url.pathname === ROUTE_VARIANTS.motion) {
    const title = "Motion — Fixture Cloud";
    return { title, html: layout(title, route, effective, motionSection()) };
  }
  if (url.pathname === ROUTE_VARIANTS.lateFont) {
    const title = "Release notes — Fixture Cloud";
    return {
      title,
      html: layout(
        title,
        route,
        effective,
        lateFontSection(lateFontDelay(url), url.searchParams.get("lazy") === "1"),
      ),
    };
  }
  if (url.pathname === ROUTE_VARIANTS.dialogs) {
    const title = "Workspace — Fixture Cloud";
    const body = dialogSection(url.searchParams.get("open") === "1");
    return { title, html: layout(title, route, effective, body) };
  }
  // The server redirects `/account` while the session is expired.
  if (url.pathname === ROUTE_VARIANTS.account) {
    const title = "Account — Fixture Cloud";
    return { title, html: layout(title, route, effective, accountSection()) };
  }
  if (url.pathname === ROUTE_VARIANTS.signIn) {
    const title = "Sign in — Fixture Cloud";
    const next = url.searchParams.get("next") ?? "/";
    return { title, html: layout(title, route, effective, signInSection(next)) };
  }
  if (url.pathname === "/") {
    const title = "Fixture Cloud";
    const body = `<section><h1>Fixture Cloud</h1><p data-hash-view></p>
<p>Open <a href="/settings">settings</a> or <a href="/pricing">pricing</a>.</p></section>`;
    return { title, html: layout(title, route, effective, body) };
  }
  return null;
}
