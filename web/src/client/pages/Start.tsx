import { useEffect, useState } from "react";

import { navigate } from "../App";
import { Checklist } from "../components/Checklist";
import { Link, Logo } from "../components/SiteHeader";
import { api } from "../lib/api";

/** Getting started: the step-by-step checklist, from account to first clips. */
export function Start() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((me) => (me.signed_in ? setReady(true) : navigate("/login?next=/start")))
      .catch(() => navigate("/login?next=/start"));
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="aurora" />
      <div className="relative mx-auto max-w-3xl px-5 py-10">
        <div className="flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-2">
            <Link to="/account" className="btn btn-ghost text-sm">
              Account
            </Link>
            <a href="/studio/" className="btn btn-ghost text-sm">
              Studio
            </a>
          </div>
        </div>
        <h1 className="mt-12 text-4xl font-extrabold tracking-tight">Get started with Kirby's Klips</h1>
        <p className="mt-3 text-ink-300">
          A few one-time steps. Each one ticks itself off when it's done, and the next one opens.
        </p>
        <div className="mt-8">{ready ? <Checklist /> : null}</div>
      </div>
    </div>
  );
}
