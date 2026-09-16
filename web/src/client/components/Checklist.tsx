import { useCallback, useEffect, useRef, useState } from "react";

import { FREE_CLIPS_PER_DAY, TOKENS_PER_CLIP } from "../../shared/pricing";
import { type Onboarding, api } from "../lib/api";
import {
  type ClaudeStatus,
  type Engine,
  claudeStatus,
  computerOs,
  findEngine,
  installClaude,
  linkEngine,
  localAccessBlocked,
  openClaudeSignIn,
  UNBLOCK_HELP,
} from "../lib/engine";
import { TokenSlider } from "./Pricing";
import { Link } from "./SiteHeader";

type StepId = "account" | "tokens" | "engine" | "claude" | "clips";

interface Step {
  id: StepId;
  title: string;
  done: boolean;
  summary: string;
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-700 border-t-brand-500" />;
}

/** Installing and opening Klips Engine, with instructions for the computer they're on. */
function EngineStep({ engine, linking, linkError, blocked }: { engine: Engine | null; linking: boolean; linkError: string; blocked: boolean }) {
  const os = computerOs();
  const primary = os === "windows" ? "windows" : "mac";
  return (
    <div className="space-y-5">
      <p className="text-ink-300">
        Klips makes clips on your own computer, so it needs the Klips Engine: a one-time install that runs quietly in the
        background. You'll use Klips right here in your browser.
      </p>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-primary" href={`/download/${primary}`}>
          Download for {primary === "mac" ? "Mac" : "Windows"}
        </a>
        <a className="btn btn-ghost" href={`/download/${primary === "mac" ? "windows" : "mac"}`}>
          Download for {primary === "mac" ? "Windows" : "Mac"}
        </a>
      </div>
      {primary === "mac" ? (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-300">
          <li>Open <b className="text-ink-100">Klips-mac.dmg</b> from your Downloads and drag <b className="text-ink-100">Klips</b> into Applications.</li>
          <li>
            Open Klips from Applications. The first time, macOS may say it can't check the developer: right-click Klips,
            choose <b className="text-ink-100">Open</b>, then <b className="text-ink-100">Open</b> again.
          </li>
          <li>Come back to this tab. It connects by itself.</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-300">
          <li>Run <b className="text-ink-100">Klips-windows-setup.exe</b> from your Downloads.</li>
          <li>
            If Windows says it protected your PC, click <b className="text-ink-100">More info</b>, then{" "}
            <b className="text-ink-100">Run anyway</b>. Finish the installer and Klips starts by itself.
          </li>
          <li>Come back to this tab. It connects by itself.</li>
        </ol>
      )}
      <div className="rounded-xl border border-ink-700 bg-ink-950 p-4 text-sm text-ink-300">
        <div className="flex items-center gap-2 font-semibold text-ink-100">
          {engine ? (linking ? <Spinner /> : null) : <Spinner />}
          {engine
            ? linking
              ? "Found Klips Engine. Connecting it to your account…"
              : "Klips Engine found."
            : "Waiting for Klips Engine to start on this computer…"}
        </div>
        <p className="mt-2">
          If your browser asks to let klips.pro connect to apps or devices on this computer, choose{" "}
          <b className="text-ink-100">Allow</b>. That's how the website talks to the engine.
        </p>
        {blocked ? <p className="mt-2 text-red-400">{UNBLOCK_HELP}</p> : null}
        {linkError ? <p className="mt-2 text-red-400">{linkError}</p> : null}
      </div>
    </div>
  );
}

/** Installing Claude Code and signing in, driven through the engine. */
function ClaudeStep({ engine, status, onChange }: { engine: Engine | null; status: ClaudeStatus | null; onChange: () => void }) {
  const [busy, setBusy] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");

  if (!engine) {
    return (
      <div className="flex items-center gap-2 text-ink-300">
        <Spinner /> Open Klips on this computer to continue. This step needs the Klips Engine running.
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex items-center gap-2 text-ink-300">
        <Spinner /> Checking Claude Code on this computer…
      </div>
    );
  }

  const installing = status.install?.state === "running";
  const windows = status.platform === "windows";

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await action();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-ink-300">
        Klips uses your own Claude Pro or Max subscription, through Claude Code, to pick the best moments and write your
        titles. Two quick parts:
      </p>

      <div className={`rounded-xl border p-4 ${status.installed ? "border-emerald-500/40" : "border-ink-700"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold">
            {status.installed ? <span className="text-emerald-400"><Check /></span> : null}
            Install Claude Code
          </div>
          {status.installed ? (
            <span className="text-sm font-semibold text-emerald-400">Complete</span>
          ) : (
            <button
              type="button"
              className="btn btn-primary text-sm"
              disabled={installing || busy === "install"}
              onClick={() => run("install", () => installClaude(engine))}
            >
              {installing || busy === "install" ? <Spinner /> : null}
              {installing ? "Installing…" : status.install?.state === "failed" ? "Try again" : "Install Claude Code"}
            </button>
          )}
        </div>
        {!status.installed ? (
          <>
            <p className="mt-2 text-sm text-ink-300">
              {installing
                ? "Installing with Anthropic's official installer. This takes about a minute."
                : status.install?.error || "Free, and takes about a minute."}
            </p>
            {status.install?.log && (installing || status.install.state === "failed") ? (
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-xs text-ink-500">
                {status.install.log}
              </pre>
            ) : null}
            <details className="mt-3 text-sm text-ink-500">
              <summary>Prefer to install it yourself?</summary>
              <p className="mt-2">
                Open {windows ? "PowerShell (search for it in the Start menu)" : "Terminal"}, paste this and press Enter:
              </p>
              <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-lg bg-black px-3 py-2 text-ink-100">
                {status.install_command}
              </code>
            </details>
          </>
        ) : null}
      </div>

      <div className={`rounded-xl border p-4 ${!status.installed ? "border-ink-800 opacity-50" : "border-ink-700"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-semibold">Sign in with your Claude account</div>
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={!status.installed || busy === "signin"}
            onClick={() =>
              run("signin", async () => {
                await openClaudeSignIn(engine);
                setHint("Finish signing in in the window that opened (it takes you to claude.ai). This step completes by itself.");
              })
            }
          >
            {busy === "signin" ? <Spinner /> : null}
            Sign in to Claude
          </button>
        </div>
        <p className="mt-2 text-sm text-ink-300">
          {hint || "A window opens and takes you to claude.ai. Sign in with the account that has Claude Pro or Max."}
        </p>
        {error ? (
          <p className="mt-2 text-sm text-red-400">
            {error} You can also open {windows ? "PowerShell" : "Terminal"} and run <code>claude auth login</code>.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The after-purchase checklist. Each step checks the real state (account, tokens, the engine on this
 * computer, Claude Code, first clips), marks itself Complete, and opens the next one.
 */
export function Checklist({ compact = false }: { compact?: boolean }) {
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [startingFree, setStartingFree] = useState(false);
  const [open, setOpen] = useState<StepId | null>(null);
  const linkingRef = useRef(false);

  const loadServer = useCallback(async () => {
    try {
      setOnboarding(await api.onboarding());
    } catch {
      /* try again on the next tick */
    }
  }, []);

  const planChosen = Boolean(onboarding && (onboarding.has_tokens || onboarding.free_plan || onboarding.clips_made > 0));
  const engineNeeded = Boolean(onboarding && planChosen && onboarding.clips_made === 0);

  const loadEngine = useCallback(async () => {
    if (!onboarding) return;
    const found = await findEngine();
    if (!found) {
      setEngine(null);
      setClaude(null);
      setBlocked(await localAccessBlocked());
      return;
    }
    setBlocked(false);
    if (!(found.info.linked && found.info.account === onboarding.email) && !linkingRef.current) {
      linkingRef.current = true;
      setLinking(true);
      setLinkError("");
      try {
        await linkEngine(found, onboarding.email);
        found.info = { ...found.info, linked: true, account: onboarding.email };
        void loadServer();
      } catch (e) {
        setLinkError(`Couldn't connect the engine to your account: ${(e as Error).message}`);
      } finally {
        linkingRef.current = false;
        setLinking(false);
      }
    }
    setEngine(found);
    try {
      setClaude(await claudeStatus(found));
    } catch {
      /* engine busy; next tick */
    }
  }, [onboarding, loadServer]);

  const startFree = async () => {
    setStartingFree(true);
    try {
      await api.startFree();
      await loadServer();
    } finally {
      setStartingFree(false);
    }
  };

  useEffect(() => {
    void loadServer();
    const timer = setInterval(loadServer, 6000);
    return () => clearInterval(timer);
  }, [loadServer]);

  // Only look for the engine once it's the step that matters, so the browser's permission prompt makes sense.
  useEffect(() => {
    if (!engineNeeded || compact) return;
    void loadEngine();
    const timer = setInterval(loadEngine, 3000);
    return () => clearInterval(timer);
  }, [engineNeeded, compact, loadEngine]);

  if (!onboarding) {
    return (
      <div className="card flex items-center gap-3 p-6 text-ink-300">
        <Spinner /> Loading your setup…
      </div>
    );
  }

  const madeClips = onboarding.clips_made > 0;
  const engineReady = madeClips || Boolean(engine && engine.info.linked && engine.info.account === onboarding.email);
  const engineDone = engineReady || (onboarding.engine_linked && !engine);
  const claudeDone = madeClips || Boolean(claude?.ready);

  const steps: Step[] = [
    { id: "account", title: "Create your account", done: true, summary: onboarding.email },
    {
      id: "tokens",
      title: "Start free or get tokens",
      done: planChosen,
      summary: onboarding.has_tokens
        ? `${onboarding.tokens.toLocaleString()} tokens · about ${Math.floor(onboarding.tokens / TOKENS_PER_CLIP).toLocaleString()} clips without a watermark`
        : `Free plan · ${FREE_CLIPS_PER_DAY} watermarked clips a day`,
    },
    {
      id: "engine",
      title: "Install Klips Engine on your computer",
      done: engineDone,
      summary: engine ? `Running on ${engine.info.device} · version ${engine.info.version}` : onboarding.engine_device ? `Installed on ${onboarding.engine_device}` : "Installed",
    },
    { id: "claude", title: "Connect your Claude Code", done: claudeDone, summary: "Signed in with your Claude account" },
    {
      id: "clips",
      title: "Make your first clips",
      done: madeClips,
      summary: `${onboarding.clips_made.toLocaleString()} clips made`,
    },
  ];

  const current = steps.find((step) => !step.done)?.id ?? null;
  const completed = steps.filter((step) => step.done).length;
  const allDone = completed === steps.length;

  if (compact) {
    if (allDone) return null;
    return (
      <div className="card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <div className="text-sm text-ink-500">Getting started</div>
          <div className="mt-1 font-semibold">
            {completed} of {steps.length} steps complete · next: {steps.find((s) => s.id === current)?.title}
          </div>
          <div className="mt-3 h-2 w-64 max-w-full overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${(completed / steps.length) * 100}%` }} />
          </div>
        </div>
        <Link to="/start" className="btn btn-primary">
          Continue setup
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            {completed} of {steps.length} complete
          </div>
          <div className="mt-3 h-2 w-72 max-w-full overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-brand-500 transition-all duration-500" style={{ width: `${(completed / steps.length) * 100}%` }} />
          </div>
        </div>
        {allDone ? (
          <a href="/studio/" className="btn btn-primary">
            Open Klips Studio
          </a>
        ) : null}
      </div>

      <ol className="space-y-3">
        {steps.map((step, index) => {
          const isCurrent = step.id === current;
          const locked = !step.done && !isCurrent;
          const expanded = isCurrent || open === step.id;
          return (
            <li
              key={step.id}
              className={`card overflow-hidden transition ${isCurrent ? "ring-2 ring-brand-500" : ""} ${locked ? "opacity-50" : ""}`}
            >
              <button
                type="button"
                disabled={locked || isCurrent}
                onClick={() => setOpen(open === step.id ? null : step.id)}
                className="flex w-full items-center gap-4 p-5 text-left disabled:cursor-default"
              >
                <span
                  className={`grid h-9 w-9 flex-none place-items-center rounded-full text-sm font-bold ${
                    step.done
                      ? "bg-emerald-500 text-ink-950"
                      : isCurrent
                        ? "bg-brand-500 text-ink-950"
                        : "border border-ink-700 text-ink-500"
                  }`}
                >
                  {step.done ? <Check /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{step.title}</span>
                  {step.done ? <span className="block truncate text-sm text-ink-500">{step.summary}</span> : null}
                  {isCurrent ? <span className="block text-sm text-brand-500">Up next</span> : null}
                </span>
                {step.done ? (
                  <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold uppercase tracking-wide text-emerald-400">
                    Complete
                  </span>
                ) : locked ? (
                  <span className="text-xs text-ink-500">Locked</span>
                ) : null}
              </button>

              {expanded && !step.done ? (
                <div className="border-t border-ink-800 p-5 sm:pl-[4.75rem]">
                  {step.id === "tokens" ? (
                    <div className="space-y-5">
                      <div className="rounded-xl border border-ink-700 bg-ink-950 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div>
                            <div className="font-semibold">Free plan</div>
                            <p className="mt-1 text-sm text-ink-300">
                              {FREE_CLIPS_PER_DAY} clips a day with a small klips.pro watermark. No card needed.
                            </p>
                          </div>
                          <button type="button" className="btn btn-ghost" onClick={startFree} disabled={startingFree}>
                            {startingFree ? <Spinner /> : null}
                            Start free
                          </button>
                        </div>
                      </div>
                      <div className="max-w-xl space-y-3">
                        <p className="text-ink-300">
                          Or buy tokens for clips without a watermark: {TOKENS_PER_CLIP} tokens per finished clip, and
                          clips that fail are refunded.
                        </p>
                        <TokenSlider />
                        <p className="text-sm text-ink-500">
                          Posting every week? <Link to="/#pricing" className="text-brand-500 hover:underline">See monthly plans</Link>.
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {step.id === "engine" ? <EngineStep engine={engine} linking={linking} linkError={linkError} blocked={blocked} /> : null}
                  {step.id === "claude" ? <ClaudeStep engine={engine} status={claude} onChange={() => void loadEngine()} /> : null}
                  {step.id === "clips" ? (
                    <div className="space-y-4">
                      <p className="text-ink-300">
                        Everything's ready. Open Klips Studio, drop in a long video, and your clips appear as they're made.
                        This step completes when your first clips finish.
                      </p>
                      <a href="/studio/" className="btn btn-primary">
                        Open Klips Studio
                      </a>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {allDone ? (
        <div className="card mt-6 p-6 text-center">
          <div className="text-2xl font-bold">You're all set.</div>
          <p className="mt-2 text-ink-300">Make more clips any time from Klips Studio.</p>
          <a href="/studio/" className="btn btn-primary mt-4">
            Open Klips Studio
          </a>
        </div>
      ) : null}
    </div>
  );
}
