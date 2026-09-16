import { useCallback, useEffect, useState } from "react";

import { formatUsd, planById } from "../../shared/pricing";
import { navigate } from "../App";
import { Checklist } from "../components/Checklist";
import { TokenSlider } from "../components/Pricing";
import { Logo } from "../components/SiteHeader";
import { type Account as AccountData, ApiError, api } from "../lib/api";

const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const REASON_LABELS: Record<string, string> = {
  purchase: "Tokens purchased",
  subscription_grant: "Plan tokens added",
  spend: "Clips generated",
  refund: "Refunded",
  manual: "Adjustment",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-6">
      <div className="text-sm text-ink-500">{label}</div>
      <div className="mt-1 text-3xl font-extrabold tracking-tight">{value}</div>
      {sub ? <div className="mt-1 text-sm text-ink-300">{sub}</div> : null}
    </div>
  );
}

/** Change password, from the Settings tab. */
function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setMessage({ ok: true, text: "Password changed. Other browsers have been signed out." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card max-w-xl space-y-4 p-6">
      <h3 className="font-semibold">Change password</h3>
      <div>
        <label className="text-sm text-ink-300" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          className="field"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label className="text-sm text-ink-300" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          className="field"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          placeholder="At least 8 characters"
          required
        />
      </div>
      {message ? <p className={`text-sm ${message.ok ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p> : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}

export function Account() {
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"history" | "tokens" | "billing" | "settings">("history");

  const load = useCallback(async () => {
    try {
      setData(await api.account());
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate("/login");
        return;
      }
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center">
        {error ? (
          <div className="card p-8 text-center">
            <p className="text-ink-300">{error}</p>
            <button type="button" className="btn btn-ghost mt-4" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-brand-500" />
        )}
      </div>
    );
  }

  const plan = data.subscription ? planById(data.subscription.plan) : undefined;
  const totalClips = data.generations.reduce((sum, g) => sum + (g.clips_delivered ?? 0), 0);

  const openBilling = async () => {
    try {
      const { url } = await api.billingPortal();
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const signOut = async () => {
    await api.signOut().catch(() => undefined);
    navigate("/");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <Logo className="text-base" />
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-ink-500 sm:inline">{data.email}</span>
            <button type="button" className="btn btn-ghost text-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10">
        <div className="grid gap-5 sm:grid-cols-3">
          <Stat
            label="Token balance"
            value={data.tokens.toLocaleString()}
            sub={`about ${data.clips_available.toLocaleString()} clips left`}
          />
          <Stat label="Clips made" value={totalClips.toLocaleString()} sub={`${data.generations.length} videos processed`} />
          <Stat
            label="Plan"
            value={plan ? plan.name : data.tokens > 0 ? "Pay as you go" : "Free"}
            sub={
              (data.subscription
                ? `${data.subscription.tokens_per_period.toLocaleString()} tokens per ${data.subscription.interval}` +
                  (data.subscription.cancel_at_period_end ? " · ends at period end" : "")
                : data.tokens > 0
                  ? "Tokens never expire"
                  : "Buy tokens to remove the watermark") +
              ` · ${data.free_clips_left} of ${data.free_clips_per_day} free clips left today`
            }
          />
        </div>

        <div className="mt-5">
          <Checklist compact />
        </div>

        <div className="card mt-5 flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <div className="font-semibold">Klips Studio</div>
            <p className="mt-1 text-sm text-ink-300">
              Make and edit clips in your browser. The work runs on your computer through Klips Engine.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a className="text-sm text-ink-500 hover:text-ink-100" href="/start">
              Setup guide
            </a>
            <a className="btn btn-primary text-sm" href="/studio/">
              Open Klips Studio
            </a>
          </div>
        </div>

        <nav className="mt-10 flex gap-1 border-b border-ink-800">
          {([
            ["history", "Your clips"],
            ["tokens", "Buy tokens"],
            ["billing", "Billing"],
            ["settings", "Settings"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded-t-lg px-4 py-3 text-sm font-semibold transition ${
                tab === value ? "border-b-2 border-brand-500 text-ink-100" : "text-ink-500 hover:text-ink-300"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "history" ? (
          <div className="mt-6 space-y-3">
            {data.generations.length === 0 ? (
              <div className="card p-10 text-center text-ink-300">
                No clips yet. Open Klips Studio and drop in a long video.
              </div>
            ) : null}
            {data.generations.map((generation) => (
              <div key={generation.id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{generation.source_name || "Untitled video"}</div>
                    <div className="mt-1 text-sm text-ink-500">
                      {formatDate(generation.created_at)}
                      {generation.device_name ? ` · ${generation.device_name}` : ""}
                      {generation.platform ? ` · ${generation.platform}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div
                      className={
                        generation.status === "completed"
                          ? "font-semibold text-emerald-400"
                          : generation.status === "failed"
                            ? "font-semibold text-red-400"
                            : "font-semibold text-brand-500"
                      }
                    >
                      {generation.status === "completed"
                        ? `${generation.clips_delivered ?? 0} clips${generation.tier === "free" ? " · free" : ""}`
                        : generation.status === "failed"
                          ? "Failed · refunded"
                          : "In progress"}
                    </div>
                    <div className="text-ink-500">
                      {generation.tier === "free" ? "Watermarked" : `${generation.tokens_charged} tokens`}
                    </div>
                  </div>
                </div>
                {generation.titles.length ? (
                  <ul className="mt-3 space-y-1 text-sm text-ink-300">
                    {generation.titles.map((title, i) => (
                      <li key={i} className="truncate">
                        • {title}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {tab === "tokens" ? (
          <div className="mt-6 max-w-xl">
            <TokenSlider />
          </div>
        ) : null}

        {tab === "billing" ? (
          <div className="mt-6 space-y-5">
            <div className="card flex flex-wrap items-center justify-between gap-4 p-6">
              <div>
                <div className="font-semibold">Payment methods, invoices and cancellation</div>
                <p className="mt-1 text-sm text-ink-300">Handled securely by Stripe.</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={openBilling} disabled={!data.has_billing}>
                Open billing portal
              </button>
            </div>
            <div className="card p-6">
              <h3 className="font-semibold">Token history</h3>
              <table className="mt-4 w-full text-sm">
                <tbody>
                  {data.ledger.map((entry, i) => (
                    <tr key={i} className="border-t border-ink-800">
                      <td className="py-2 text-ink-300">{REASON_LABELS[entry.reason] || entry.reason}</td>
                      <td className="py-2 text-ink-500">{formatDate(entry.created_at)}</td>
                      <td className={`py-2 text-right font-semibold ${entry.delta > 0 ? "text-emerald-400" : "text-ink-100"}`}>
                        {entry.delta > 0 ? "+" : ""}
                        {entry.delta}
                      </td>
                      <td className="py-2 text-right text-ink-500">{entry.balance_after}</td>
                    </tr>
                  ))}
                  {data.ledger.length === 0 ? (
                    <tr>
                      <td className="py-3 text-ink-500">Nothing yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {!data.has_billing ? (
              <p className="text-sm text-ink-500">The billing portal opens after your first purchase.</p>
            ) : null}
            {plan ? (
              <p className="text-sm text-ink-500">
                {plan.name} · {formatUsd(plan.monthlyCents)} a month equivalent ·{" "}
                {data.subscription?.current_period_end
                  ? `renews ${formatDate(data.subscription.current_period_end)}`
                  : ""}
              </p>
            ) : null}
          </div>
        ) : null}
        {tab === "settings" ? (
          <div className="mt-6 space-y-5">
            <div className="card max-w-xl p-6">
              <div className="text-sm text-ink-500">Signed in as</div>
              <div className="mt-1 font-semibold">{data.email}</div>
            </div>
            <PasswordForm />
          </div>
        ) : null}
      </main>
    </div>
  );
}
