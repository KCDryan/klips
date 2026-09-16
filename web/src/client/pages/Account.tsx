import { useCallback, useEffect, useState } from "react";

import { formatUsd, planById } from "../../shared/pricing";
import { navigate } from "../App";
import { TokenSlider } from "../components/Pricing";
import { type Account as AccountData, api, saveLicenseKey, savedLicenseKey } from "../lib/api";

const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const REASON_LABELS: Record<string, string> = {
  purchase: "Tokens purchased",
  subscription_grant: "Plan tokens added",
  spend: "Clips generated",
  refund: "Refunded",
  manual: "Adjustment",
};

function SignIn({ onSignedIn }: { onSignedIn: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.account(key.trim());
      saveLicenseKey(key.trim());
      onSignedIn(key.trim());
    } catch (e) {
      setError((e as Error).message || "That key didn't work.");
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="aurora" />
      <div className="mx-auto max-w-md px-5 py-24">
        <button type="button" onClick={() => navigate("/")} className="text-sm text-ink-500 hover:text-ink-100">
          ← Back to klips.pro
        </button>
        <div className="card mt-6 p-8">
          <h1 className="text-2xl font-bold">Your account</h1>
          <p className="mt-2 text-sm text-ink-300">
            Sign in with the licence key from your purchase. It's the same key the app uses.
          </p>
          <form onSubmit={submit} className="mt-6">
            <label className="text-sm text-ink-300" htmlFor="key">
              Licence key
            </label>
            <input
              id="key"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="KLIPS-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 font-mono tracking-wider outline-none focus:border-brand-500"
            />
            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
            <button type="submit" className="btn btn-primary mt-5 w-full" disabled={busy || key.length < 8}>
              {busy ? "Checking…" : "Sign in"}
            </button>
          </form>
          <p className="mt-5 text-sm text-ink-500">
            Don't have a key yet?{" "}
            <button type="button" className="text-brand-500 hover:underline" onClick={() => navigate("/")}>
              Buy tokens
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-6">
      <div className="text-sm text-ink-500">{label}</div>
      <div className="mt-1 text-3xl font-extrabold tracking-tight">{value}</div>
      {sub ? <div className="mt-1 text-sm text-ink-300">{sub}</div> : null}
    </div>
  );
}

export function Account() {
  const [licenseKey, setLicenseKey] = useState(savedLicenseKey());
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"history" | "tokens" | "billing">("history");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (key: string) => {
    try {
      setData(await api.account(key));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status === 403) {
        saveLicenseKey("");
        setLicenseKey("");
      }
    }
  }, []);

  useEffect(() => {
    if (licenseKey) void load(licenseKey);
  }, [licenseKey, load]);

  if (!licenseKey) {
    return <SignIn onSignedIn={setLicenseKey} />;
  }

  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center">
        {error ? (
          <div className="card p-8 text-center">
            <p className="text-ink-300">{error}</p>
            <button type="button" className="btn btn-ghost mt-4" onClick={() => void load(licenseKey)}>
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
      const { url } = await api.billingPortal(licenseKey);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyKey = async () => {
    await navigator.clipboard.writeText(data.license_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <button type="button" onClick={() => navigate("/")} className="flex items-center gap-2 font-extrabold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">K</span>
            Klips
          </button>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-ink-500 sm:inline">{data.email}</span>
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={() => {
                saveLicenseKey("");
                setLicenseKey("");
                setData(null);
              }}
            >
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
            value={plan ? plan.name : "Pay as you go"}
            sub={
              data.subscription
                ? `${data.subscription.tokens_per_period.toLocaleString()} tokens per ${data.subscription.interval}` +
                  (data.subscription.cancel_at_period_end ? " · ends at period end" : "")
                : "Tokens never expire"
            }
          />
        </div>

        <div className="card mt-5 flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <div className="text-sm text-ink-500">Licence key — use this in the app</div>
            <code className="mt-1 block font-mono text-lg tracking-wider text-brand-500">{data.license_key}</code>
          </div>
          <button type="button" className="btn btn-ghost" onClick={copyKey}>
            {copied ? "Copied" : "Copy key"}
          </button>
        </div>

        <nav className="mt-10 flex gap-1 border-b border-ink-800">
          {([
            ["history", "Your clips"],
            ["tokens", "Buy tokens"],
            ["billing", "Billing"],
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
                No clips yet. Open the Klips app, paste your licence key and drop in a video.
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
                        ? `${generation.clips_delivered ?? 0} clips`
                        : generation.status === "failed"
                          ? "Failed · refunded"
                          : "In progress"}
                    </div>
                    <div className="text-ink-500">{generation.tokens_charged} tokens</div>
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
      </main>
    </div>
  );
}
