import { useEffect, useState } from "react";

import { TOKENS_PER_CLIP } from "../../shared/pricing";
import { navigate } from "../App";
import { api, saveLicenseKey } from "../lib/api";

/** Shown straight after Stripe checkout: hands over the licence key and the download. */
export function Welcome() {
  const [state, setState] = useState<{ email?: string; key?: string; tokens?: number; error?: string; pending?: boolean }>({
    pending: true,
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (!sessionId) {
      setState({ error: "This page opens after checkout. Use your licence key to sign in instead." });
      return;
    }
    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      attempts += 1;
      try {
        const data = await api.welcome(sessionId);
        if (cancelled) return;
        if (data.license_key) {
          saveLicenseKey(data.license_key);
          setState({ email: data.email, key: data.license_key, tokens: data.tokens });
          return;
        }
        if (attempts < 15) setTimeout(poll, 2000); // Stripe's webhook may still be in flight
        else setState({ error: "Payment received, but the account is still being set up. Refresh in a moment." });
      } catch (e) {
        if (cancelled) return;
        if (attempts < 15) setTimeout(poll, 2000);
        else setState({ error: (e as Error).message });
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async () => {
    if (!state.key) return;
    await navigator.clipboard.writeText(state.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="aurora" />
      <div className="mx-auto max-w-2xl px-5 py-20">
        {state.pending && !state.key && !state.error ? (
          <div className="card p-10 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-brand-500" />
            <p className="mt-4 text-ink-300">Setting up your account…</p>
          </div>
        ) : null}

        {state.error ? (
          <div className="card p-10 text-center">
            <h1 className="text-2xl font-bold">Almost there</h1>
            <p className="mt-3 text-ink-300">{state.error}</p>
            <button type="button" className="btn btn-ghost mt-6" onClick={() => navigate("/account")}>
              Go to your account
            </button>
          </div>
        ) : null}

        {state.key ? (
          <div className="rise">
            <h1 className="text-4xl font-extrabold tracking-tight">You're in.</h1>
            <p className="mt-3 text-ink-300">
              {state.tokens?.toLocaleString()} tokens are on your account
              {state.email ? `, under ${state.email}` : ""}. That's about{" "}
              {Math.floor((state.tokens ?? 0) / TOKENS_PER_CLIP).toLocaleString()} clips.
            </p>

            <div className="card mt-8 p-7">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Your licence key</h2>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <code className="rounded-lg bg-ink-950 px-4 py-3 text-lg font-bold tracking-wider text-brand-500">
                  {state.key}
                </code>
                <button type="button" className="btn btn-ghost" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-3 text-sm text-ink-500">
                This key unlocks the app and signs you in here. Keep it somewhere safe — it's also in your email receipt.
              </p>
            </div>

            <div className="card mt-6 p-7">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Next steps</h2>
              <ol className="mt-4 space-y-4 text-ink-300">
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
                  <span className="font-semibold text-ink-100">2. Paste your licence key</span> when the app opens.
                </li>
                <li>
                  <span className="font-semibold text-ink-100">3. Connect Claude Code</span> — the app walks you
                  through signing in with your own Claude subscription.
                </li>
              </ol>
            </div>

            <button type="button" className="btn btn-ghost mt-8" onClick={() => navigate("/account")}>
              Go to your account
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
