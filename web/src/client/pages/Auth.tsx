import { useState } from "react";

import { navigate } from "../App";
import { Link, Logo } from "../components/SiteHeader";
import { ApiError, api, startCheckout, takePendingPurchase } from "../lib/api";

export type AuthMode = "login" | "signup" | "forgot" | "reset";

const TITLES: Record<AuthMode, { title: string; blurb: string }> = {
  login: { title: "Welcome back", blurb: "Sign in to see your tokens, clips and billing." },
  signup: { title: "Create your account", blurb: "One account for klips.pro and the Klips app." },
  forgot: { title: "Reset your password", blurb: "We'll email you a link to choose a new one." },
  reset: { title: "Choose a new password", blurb: "You'll be signed in straight after." },
};

/** After signing in: carry on with a purchase they started, or go to their account. */
async function continueAfterAuth(): Promise<void> {
  const pending = takePendingPurchase();
  if (pending) {
    try {
      if (await startCheckout(pending, () => navigate("/login"))) return;
    } catch {
      /* checkout unavailable: land on the account page, where they can try again */
    }
  }
  navigate("/account");
}

export function Auth({ mode }: { mode: AuthMode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { title, blurb } = TITLES[mode];
  const token = new URLSearchParams(window.location.search).get("token") || "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "login") {
        await api.signIn(email, password);
        await continueAfterAuth();
      } else if (mode === "signup") {
        await api.signUp(email, password, needsKey ? licenseKey : undefined);
        await continueAfterAuth();
      } else if (mode === "forgot") {
        await api.forgotPassword(email);
        setNotice(`If ${email} has a Klips account, a reset link is on its way. Check your inbox and spam folder.`);
      } else {
        await api.resetPassword(token, password);
        await continueAfterAuth();
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.data.code : undefined;
      if (code === "needs_license") setNeedsKey(true);
      setError((e as Error).message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const needsPassword = mode !== "forgot";
  const needsEmail = mode !== "reset";

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="aurora" />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col px-5 py-10">
        <Logo />
        <div className="card rise mt-10 p-8">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-ink-300">{blurb}</p>

          {mode === "reset" && !token ? (
            <p className="mt-6 text-sm text-red-400">
              This link is missing its code. Open the link from your email again, or{" "}
              <Link to="/forgot" className="text-brand-500 hover:underline">
                ask for a new one
              </Link>
              .
            </p>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4">
              {needsEmail ? (
                <div>
                  <label className="text-sm text-ink-300" htmlFor="email">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    className="field"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                    required
                  />
                </div>
              ) : null}

              {needsPassword ? (
                <div>
                  <div className="flex items-baseline justify-between">
                    <label className="text-sm text-ink-300" htmlFor="password">
                      {mode === "login" ? "Password" : "New password"}
                    </label>
                    {mode === "login" ? (
                      <Link to="/forgot" className="text-sm text-ink-500 hover:text-ink-100">
                        Forgot password?
                      </Link>
                    ) : null}
                  </div>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      className="field"
                      style={{ paddingRight: "4rem" }}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      minLength={mode === "login" ? undefined : 8}
                      autoFocus={mode === "reset"}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 mt-1 -translate-y-1/2 text-xs font-semibold text-ink-500 hover:text-ink-100"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
              ) : null}

              {mode === "signup" && needsKey ? (
                <div>
                  <label className="text-sm text-ink-300" htmlFor="key">
                    Licence key from your receipt
                  </label>
                  <input
                    id="key"
                    className="field font-mono tracking-wider"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                    placeholder="KLIPS-XXXX-XXXX-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <p className="mt-2 text-xs text-ink-500">Only needed once, to prove the earlier purchase is yours.</p>
                </div>
              ) : null}

              {error ? <p className="text-sm text-red-400">{error}</p> : null}
              {notice ? <p className="text-sm text-emerald-400">{notice}</p> : null}

              <button type="submit" className="btn btn-primary w-full" disabled={busy}>
                {busy
                  ? "One moment…"
                  : mode === "login"
                    ? "Sign in"
                    : mode === "signup"
                      ? "Create account"
                      : mode === "forgot"
                        ? "Email me a reset link"
                        : "Save password and sign in"}
              </button>

              {mode === "signup" ? (
                <p className="text-center text-xs text-ink-500">
                  By creating an account you agree to the{" "}
                  <Link to="/terms" className="underline hover:text-ink-100">
                    Terms
                  </Link>{" "}
                  and{" "}
                  <Link to="/privacy" className="underline hover:text-ink-100">
                    Privacy Policy
                  </Link>
                  .
                </p>
              ) : null}
            </form>
          )}

          <div className="mt-6 border-t border-ink-800 pt-5 text-center text-sm text-ink-500">
            {mode === "login" ? (
              <>
                New to Klips?{" "}
                <Link to="/signup" className="font-semibold text-brand-500 hover:underline">
                  Create an account
                </Link>
              </>
            ) : mode === "signup" ? (
              <>
                Already have an account?{" "}
                <Link to="/login" className="font-semibold text-brand-500 hover:underline">
                  Sign in
                </Link>
              </>
            ) : (
              <Link to="/login" className="font-semibold text-brand-500 hover:underline">
                Back to sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
