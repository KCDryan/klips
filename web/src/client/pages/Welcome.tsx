import { useEffect, useState } from "react";

import { TOKENS_PER_CLIP, planById } from "../../shared/pricing";
import { Link, Logo } from "../components/SiteHeader";
import { api } from "../lib/api";

type State =
  | { phase: "waiting" }
  | { phase: "ready"; email?: string; tokens: number; added: number; plan?: string | null }
  | { phase: "error"; message: string };

/** Shown straight after Stripe checkout: confirms the tokens landed and points to the download. */
export function Welcome() {
  const [state, setState] = useState<State>({ phase: "waiting" });

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (!sessionId) {
      setState({ phase: "error", message: "This page opens after checkout. Your tokens are always on your account page." });
      return;
    }
    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      attempts += 1;
      try {
        const data = await api.welcome(sessionId);
        if (cancelled) return;
        if (data.ready) {
          setState({ phase: "ready", email: data.email, tokens: data.tokens ?? 0, added: data.added ?? 0, plan: data.plan });
          return;
        }
      } catch {
        /* keep trying: Stripe's confirmation can take a few seconds */
      }
      if (cancelled) return;
      if (attempts < 20) setTimeout(poll, 2000);
      else setState({ phase: "error", message: "Payment received. Your tokens are still on their way; they'll show on your account page in a minute." });
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="aurora" />
      <div className="relative mx-auto max-w-2xl px-5 py-10">
        <Logo />
        <div className="mt-12">
          {state.phase === "waiting" ? (
            <div className="card p-10 text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-brand-500" />
              <p className="mt-4 text-ink-300">Adding your tokens…</p>
            </div>
          ) : null}

          {state.phase === "error" ? (
            <div className="card p-10 text-center">
              <h1 className="text-2xl font-bold">Almost there</h1>
              <p className="mt-3 text-ink-300">{state.message}</p>
              <Link to="/account" className="btn btn-primary mt-6">
                Go to your account
              </Link>
            </div>
          ) : null}

          {state.phase === "ready" ? (
            <div className="rise">
              <h1 className="text-4xl font-extrabold tracking-tight">You're in.</h1>
              <p className="mt-3 text-ink-300">
                {state.plan ? `Your ${planById(state.plan)?.name ?? ""} plan is active. ` : ""}
                {state.added.toLocaleString()} tokens were added
                {state.email ? ` to ${state.email}` : ""}. You now have {state.tokens.toLocaleString()} tokens, about{" "}
                {Math.floor(state.tokens / TOKENS_PER_CLIP).toLocaleString()} clips.
              </p>

              <div className="card mt-8 p-7">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Next steps</h2>
                <ol className="mt-4 space-y-5 text-ink-300">
                  <li>
                    <span className="font-semibold text-ink-100">1. Download Klips</span>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <a className="btn btn-primary text-sm" href="/download/mac">
                        Download for Mac
                      </a>
                      <a className="btn btn-ghost text-sm" href="/download/windows">
                        Download for Windows
                      </a>
                    </div>
                  </li>
                  <li>
                    <span className="font-semibold text-ink-100">2. Sign in to the app</span> with the same email and
                    password you use here.
                  </li>
                  <li>
                    <span className="font-semibold text-ink-100">3. Connect Claude Code</span> — the app walks you
                    through signing in with your own Claude subscription.
                  </li>
                </ol>
              </div>

              <Link to="/account" className="btn btn-ghost mt-8">
                Go to your account
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
