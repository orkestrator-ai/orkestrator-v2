import { useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowRight,
  Ban,
  Bot,
  Check,
  CircleCheck,
  Container,
  Copy,
  Eye,
  FileCheck,
  Fingerprint,
  GitBranch,
  GitPullRequest,
  Loader2,
  LogIn,
  Mail,
  MonitorSmartphone,
  Network,
  Palette,
  Server,
  ShieldCheck,
  SquareKanban,
  Workflow,
} from "lucide-react";
import orkLogo from "../../../logos/ork-logo2.png";
import { CONNECT_PATH } from "./routes";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const GITHUB_URL = "https://github.com/orkestrator-ai/orkestrator-v2";
const INSTALL_COMMAND =
  "curl -fsSL https://orkestrator.dev/install.sh | bash -s -- --tailscale-serve --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev";

const AGENTS = ["Claude Code", "Codex", "OpenCode", "Cursor Agent", "Grok Build", "Pi"];

const SECURITY_FEATURES: Array<{ icon: Icon; title: string; body: string }> = [
  {
    icon: Ban,
    title: "Default-deny egress",
    body: "An iptables firewall lets traffic out only to approved domains. If the rules can’t be applied, the container doesn’t start.",
  },
  {
    icon: Fingerprint,
    title: "Unprivileged agents",
    body: "Agents run as a non-root user with no path to root. Sudo covers exactly the firewall and setup scripts.",
  },
  {
    icon: GitBranch,
    title: "One container per branch",
    body: "Each environment gets its own workspace, terminal, Git branch and Docker network, so parallel tasks never collide.",
  },
  {
    icon: ShieldCheck,
    title: "Approvals fail safe",
    body: "A timeout, a disconnect or a malformed answer denies the request. Stopping a container never approves one.",
  },
  {
    icon: FileCheck,
    title: "Verified toolchain",
    body: "Every agent CLI is pinned to an exact version, and downloads are checked against their SHA-256 before use.",
  },
  {
    icon: Server,
    title: "Your hardware, your network",
    body: "This site is static files. Your browser talks straight to your own backend over your tailnet.",
  },
];

const EGRESS_LOG: Array<{ host: string; allowed: boolean }> = [
  { host: "github.com:443", allowed: true },
  { host: "api.anthropic.com:443", allowed: true },
  { host: "registry.npmjs.org:443", allowed: true },
  { host: "paste.example.net:443", allowed: false },
  { host: "203.0.113.7:22", allowed: false },
];

type StageState = "done" | "running" | "queued";

const PIPELINE_STAGES: Array<{ name: string; detail: string; state: StageState }> = [
  { name: "Build", detail: "implements the task", state: "done" },
  { name: "Validate", detail: "6 checks passed", state: "done" },
  { name: "Review", detail: "3 independent reviewers", state: "done" },
  { name: "Address", detail: "4 findings handled", state: "done" },
  { name: "Verify", detail: "re-checks the fixes", state: "running" },
  { name: "Pull request", detail: "opens and watches CI", state: "queued" },
];

const FINDINGS: Array<{
  severity: "high" | "medium" | "low";
  title: string;
  at: string;
  by: number;
}> = [
  { severity: "high", title: "Token compared with ===", at: "gateway-auth.ts:88", by: 3 },
  { severity: "medium", title: "Retry loop has no upper bound", at: "bridge-client.ts:141", by: 2 },
  { severity: "low", title: "Stale comment after rename", at: "connect.tsx:12", by: 1 },
];

const REVIEW_STEPS = [
  {
    title: "Prepare",
    body: "An agent commits the change and plans the checks. A worker runs them and seals the output into one package with SHA-256 digests.",
  },
  {
    title: "Fan out",
    body: "Every reviewer gets the same package: same HEAD, same test evidence. Mix providers and models to catch what one would miss.",
  },
  {
    title: "Consolidate & fix",
    body: "Duplicate findings collapse into one list. Fix by hand, hand it to an agent, or let the run open the pull request.",
  },
];

const MORE_FEATURES: Array<{ icon: Icon; title: string; body: string }> = [
  {
    icon: Bot,
    title: "Coordinator",
    body: "A main agent delegates to side agents asynchronously and keeps track of their work.",
  },
  {
    icon: Mail,
    title: "Agent mail",
    body: "Durable mailboxes let agents message each other, with budgets and automatic retry.",
  },
  {
    icon: SquareKanban,
    title: "Kanban tickets",
    body: "Project tickets that agents read, create and update over MCP.",
  },
  {
    icon: Eye,
    title: "Previews & annotations",
    body: "Open running services privately and mark up the page for an agent to fix.",
  },
  {
    icon: Palette,
    title: "Design canvas",
    body: "An HTML/CSS canvas with history, sync and safe export.",
  },
  {
    icon: MonitorSmartphone,
    title: "Anywhere",
    body: "Desktop app, this web client, the iOS app and the CLI all drive the same backend.",
  },
];

function LoginButton({ label, className }: { label: string; className?: string }) {
  return (
    <a className={`landing-button landing-button--primary ${className ?? ""}`} href={CONNECT_PATH}>
      <LogIn aria-hidden="true" />
      {label}
    </a>
  );
}

function Brand() {
  return (
    <a className="landing-brand" href="/" aria-label="Orkestrator home">
      <img src={orkLogo} alt="" width={36} height={36} />
      <span>Orkestrator</span>
    </a>
  );
}

function ReviewGraph() {
  return (
    <figure className="landing-window" aria-label="A Multi Review run shown as a graph">
      <div className="landing-window__bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>Multi Review · feature/gateway-auth</span>
      </div>
      <div className="flow">
        <div className="flow-node flow-node--package">
          <span className="flow-node__label">Package</span>
          <b>Sealed evidence</b>
          <small>HEAD a5d338c</small>
          <span className="flow-chips">
            {["lint", "types", "tests"].map((check) => (
              <span key={check}>
                <Check aria-hidden="true" />
                {check}
              </span>
            ))}
          </span>
        </div>
        <FlowEdges kind="fan-out" />
        <div className="flow-reviewers">
          {[
            { name: "Claude Code", meta: "3 findings" },
            { name: "Codex", meta: "2 findings" },
            { name: "OpenCode", meta: "1 finding" },
          ].map((reviewer) => (
            <div key={reviewer.name} className="flow-node flow-node--reviewer">
              <span className="flow-node__label">Reviewer</span>
              <b>{reviewer.name}</b>
              <small>{reviewer.meta}</small>
            </div>
          ))}
        </div>
        <FlowEdges kind="fan-in" />
        <div className="flow-node flow-node--consolidate">
          <span className="flow-node__label">Consolidate</span>
          <b>3 unique findings</b>
          <small>6 reported</small>
        </div>
        <FlowEdges kind="straight" />
        <div className="flow-node flow-node--fix">
          <span className="flow-node__label">Fix</span>
          <b>
            <Loader2 className="landing-spin" aria-hidden="true" /> Applying
          </b>
          <small>then opens PR</small>
        </div>
      </div>
    </figure>
  );
}

/** Edges between graph columns. Reviewer rows sit at 1/6, 1/2 and 5/6 of the height. */
function FlowEdges({ kind }: { kind: "fan-out" | "fan-in" | "straight" }) {
  const rows = kind === "straight" ? [50] : [16.67, 50, 83.33];
  return (
    <svg className="flow-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {rows.map((y) => {
        const [from, to] = kind === "fan-in" ? [y, 50] : [50, y];
        return (
          <path
            key={y}
            d={`M0 ${from} C50 ${from} 50 ${to} 100 ${to}`}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function ContainerCard() {
  return (
    <figure
      className="landing-window container-card"
      aria-label="An isolated environment and its egress log"
    >
      <div className="container-card__head">
        <span className="container-card__icon">
          <Container aria-hidden="true" />
        </span>
        <span>
          <b>feature/gateway-auth</b>
          <small>container · user node (uid 1000) · own network</small>
        </span>
        <span className="status-pill status-pill--ok">restricted</span>
      </div>
      <ul className="egress-log" aria-label="Outbound connections">
        {EGRESS_LOG.map((entry) => (
          <li key={entry.host} data-allowed={entry.allowed}>
            {entry.allowed ? <CircleCheck aria-hidden="true" /> : <Ban aria-hidden="true" />}
            <code>{entry.host}</code>
            <span>{entry.allowed ? "allowed" : "blocked"}</span>
          </li>
        ))}
      </ul>
      <div className="approval-row">
        <ShieldCheck aria-hidden="true" />
        <span>
          <b>Approval needed</b>
          <small>No answer within the timeout means deny.</small>
        </span>
      </div>
    </figure>
  );
}

function StageRail() {
  return (
    <ol className="stage-rail">
      {PIPELINE_STAGES.map((stage) => (
        <li key={stage.name} data-state={stage.state}>
          <span className="stage-rail__dot" aria-hidden="true">
            {stage.state === "done" && <Check />}
            {stage.state === "running" && <Loader2 className="landing-spin" />}
          </span>
          <b>{stage.name}</b>
          <small>{stage.detail}</small>
        </li>
      ))}
    </ol>
  );
}

function FindingsList() {
  return (
    <ul className="findings">
      {FINDINGS.map((finding) => (
        <li key={finding.title}>
          <span className={`severity severity--${finding.severity}`}>{finding.severity}</span>
          <span className="findings__text">
            <b>{finding.title}</b>
            <code>{finding.at}</code>
          </span>
          <span className="findings__by">
            {finding.by} of 3<small>reviewers</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the command stays selectable.
    }
  };
  return (
    <div className="install-command">
      <code>
        <span aria-hidden="true">$ </span>
        {INSTALL_COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Install command copied" : "Copy install command"}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav__inner">
          <Brand />
          <nav aria-label="Sections">
            <a href="#security">Security</a>
            <a href="#graphs">Pipelines</a>
            <a href="#multi-review">Multi Review</a>
            <a href={GITHUB_URL} rel="noreferrer">
              GitHub
            </a>
          </nav>
          <a
            className="landing-button landing-button--quiet landing-nav__login"
            href={CONNECT_PATH}
          >
            <LogIn aria-hidden="true" />
            Log in
          </a>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero__copy">
            <p className="landing-eyebrow">Agentic development, contained</p>
            <h1 id="landing-title">
              Every agent in a sealed container. <em>Every change through a review graph.</em>
            </h1>
            <p className="landing-lead">
              Orkestrator runs coding agents in isolated Docker environments on your own machine,
              then moves their work through pipelines that build, validate, fan out to independent
              reviewers and open the pull request.
            </p>
            <div className="landing-actions">
              <LoginButton label="Log in to your Orkestrator backend" />
              <a className="landing-button landing-button--secondary" href="#security">
                See how it works
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>
          <ReviewGraph />
          <div className="landing-agents" aria-label="Supported agents">
            <span>Works with</span>
            <ul>
              {AGENTS.map((agent) => (
                <li key={agent}>{agent}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="security" className="landing-section" aria-labelledby="security-title">
          <div className="landing-split">
            <div>
              <p className="landing-eyebrow landing-eyebrow--green">
                <ShieldCheck aria-hidden="true" /> Security
              </p>
              <h2 id="security-title">Isolation is the default, not a setting.</h2>
              <p className="landing-lead">
                Each environment is its own Docker container. Agents can move fast because they
                can’t reach what they shouldn’t: not your home directory, not other branches, not
                arbitrary hosts on the internet.
              </p>
            </div>
            <ContainerCard />
          </div>
          <ul className="feature-grid">
            {SECURITY_FEATURES.map(({ icon: FeatureIcon, title, body }) => (
              <li key={title}>
                <span className="feature-icon feature-icon--green">
                  <FeatureIcon aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="graphs" className="landing-section" aria-labelledby="graphs-title">
          <div className="landing-section__intro">
            <p className="landing-eyebrow">
              <Workflow aria-hidden="true" /> Graph-based development
            </p>
            <h2 id="graphs-title">Work moves through a graph, not a chat scroll.</h2>
            <p className="landing-lead">
              Hand off a task and Orkestrator runs it as connected agent sessions in the background.
              Every stage is a node you can open, inspect, restart or take over, and it keeps going
              while you work somewhere else.
            </p>
          </div>

          <div className="graph-cards">
            <article className="graph-card">
              <span className="feature-icon">
                <GitPullRequest aria-hidden="true" />
              </span>
              <h3>Build pipelines</h3>
              <p>
                From task to pull request in one run. Validation evidence feeds review, findings
                feed fixes, and merge conflicts get a stage of their own.
              </p>
              <StageRail />
            </article>
            <article id="multi-review" className="graph-card" aria-labelledby="multi-review-title">
              <span className="feature-icon">
                <Network aria-hidden="true" />
              </span>
              <h3 id="multi-review-title">Multi Review</h3>
              <p>
                Send one change to several reviewers at once and get back a single list of what they
                found, each finding traced to the reviewers who raised it.
              </p>
              <FindingsList />
            </article>
          </div>

          <ol className="review-steps">
            {REVIEW_STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="review-steps__index">{String(index + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section" aria-labelledby="more-title">
          <div className="landing-section__intro">
            <p className="landing-eyebrow">And the rest of the workshop</p>
            <h2 id="more-title">Agents that can work together.</h2>
          </div>
          <ul className="feature-grid feature-grid--compact">
            {MORE_FEATURES.map(({ icon: FeatureIcon, title, body }) => (
              <li key={title}>
                <span className="feature-icon">
                  <FeatureIcon aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-cta" aria-labelledby="cta-title">
          <img src={orkLogo} alt="" width={88} height={88} />
          <h2 id="cta-title">Your backend, one click away.</h2>
          <p className="landing-lead">
            Connect this browser directly to an Orkestrator backend on your private network. This
            site only serves static files; commands, terminals and agent sessions never pass through
            it.
          </p>
          <LoginButton label="Log in to your Orkestrator backend" />
          <div className="landing-cta__install">
            <p>No backend yet? Start one on macOS or Linux:</p>
            <InstallCommand />
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <Brand />
        <nav aria-label="Footer">
          <a href={GITHUB_URL} rel="noreferrer">
            GitHub
          </a>
          <a href={`${GITHUB_URL}/releases`} rel="noreferrer">
            Releases
          </a>
          <a href={CONNECT_PATH}>Connect</a>
        </nav>
      </footer>
    </div>
  );
}
