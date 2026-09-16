import { useState } from "react";

import {
  PACK,
  PLANS,
  TOKENS_PER_CLIP,
  YEARLY_DISCOUNT,
  clipsForTokens,
  formatUsd,
  packCents,
  planCents,
} from "../../shared/pricing";
import { api } from "../lib/api";

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-950/40 border-t-ink-950" />;
}

/** One-off token pack: drag the slider, pay once, tokens never expire. */
export function TokenSlider() {
  const [tokens, setTokens] = useState(PACK.defaultTokens);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const checkout = async () => {
    setBusy(true);
    setError("");
    try {
      const { url } = await api.buyTokens(tokens);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message || "Checkout is unavailable right now.");
      setBusy(false);
    }
  };

  const percent = ((tokens - PACK.minTokens) / (PACK.maxTokens - PACK.minTokens)) * 100;

  return (
    <div className="card p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold">Buy tokens</h3>
          <p className="text-ink-300">Pay once. Tokens never expire.</p>
        </div>
        <div className="text-right">
          <div className="text-5xl font-extrabold tracking-tight text-brand-500">{formatUsd(packCents(tokens))}</div>
          <div className="text-ink-300">
            {tokens.toLocaleString()} tokens · about {clipsForTokens(tokens).toLocaleString()} clips
          </div>
        </div>
      </div>

      <div className="mt-8">
        <input
          type="range"
          className="slider"
          min={PACK.minTokens}
          max={PACK.maxTokens}
          step={PACK.stepTokens}
          value={tokens}
          onChange={(e) => setTokens(Number(e.target.value))}
          aria-label="How many tokens to buy"
          style={{
            background: `linear-gradient(90deg, var(--color-brand-500) ${percent}%, var(--color-ink-700) ${percent}%)`,
          }}
        />
        <div className="mt-2 flex justify-between text-sm text-ink-500">
          <span>$1 · 10 tokens</span>
          <span>$100 · 1,000 tokens</span>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {[50, 100, 300, 1000].map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setTokens(preset)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition ${
              tokens === preset ? "border-brand-500 text-brand-500" : "border-ink-700 text-ink-300 hover:border-ink-500"
            }`}
          >
            {preset} tokens
          </button>
        ))}
      </div>

      <button type="button" className="btn btn-primary mt-8 w-full text-base" onClick={checkout} disabled={busy}>
        {busy ? <Spinner /> : null}
        {busy ? "Opening checkout…" : `Buy ${tokens.toLocaleString()} tokens`}
      </button>
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      <p className="mt-3 text-center text-sm text-ink-500">
        {TOKENS_PER_CLIP} tokens per finished clip. Clips that fail are refunded automatically.
      </p>
    </div>
  );
}

/** Monthly and yearly plans, for people posting regularly. */
export function PlanCards() {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const checkout = async (plan: string) => {
    setBusy(plan);
    setError("");
    try {
      const { url } = await api.subscribe(plan, interval);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message || "Checkout is unavailable right now.");
      setBusy("");
    }
  };

  return (
    <div>
      <div className="mb-8 flex justify-center">
        <div className="inline-flex rounded-xl border border-ink-700 bg-ink-900 p-1">
          {(["month", "year"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setInterval(option)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                interval === option ? "bg-brand-500 text-ink-950" : "text-ink-300 hover:text-ink-100"
              }`}
            >
              {option === "month" ? "Monthly" : `Yearly · save ${Math.round(YEARLY_DISCOUNT * 100)}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {PLANS.map((plan) => {
          const cents = planCents(plan, interval);
          return (
            <div
              key={plan.id}
              className={`card relative flex flex-col p-7 ${plan.popular ? "ring-2 ring-brand-500" : ""}`}
            >
              {plan.popular ? (
                <span className="absolute -top-3 left-7 rounded-full bg-brand-500 px-3 py-1 text-xs font-bold text-ink-950">
                  Most popular
                </span>
              ) : null}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-ink-300">{plan.blurb}</p>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold tracking-tight">{formatUsd(cents)}</span>
                <span className="text-ink-500">/{interval === "month" ? "month" : "year"}</span>
              </div>
              {interval === "year" ? (
                <p className="mt-1 text-sm text-brand-500">
                  {formatUsd(Math.round(cents / 12))} a month, billed once a year
                </p>
              ) : null}
              <ul className="mt-6 space-y-2 text-sm text-ink-300">
                {plan.highlights.map((line) => (
                  <li key={line} className="flex gap-2">
                    <span className="text-brand-500">✓</span>
                    {line}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={`btn mt-7 w-full ${plan.popular ? "btn-primary" : "btn-ghost"}`}
                onClick={() => checkout(plan.id)}
                disabled={busy === plan.id}
              >
                {busy === plan.id ? "Opening checkout…" : `Choose ${plan.name}`}
              </button>
            </div>
          );
        })}
      </div>
      {error ? <p className="mt-4 text-center text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
