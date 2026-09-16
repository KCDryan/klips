import { useEffect, useState } from "react";

import { navigate } from "../App";
import { type Me, api } from "../lib/api";

/** The Klips mark. A real link, so it gets the pointer, middle-click and "open in new tab". */
export function Logo({ className = "text-lg" }: { className?: string }) {
  return (
    <a
      href="/"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate("/");
      }}
      className={`flex items-center gap-2 font-extrabold ${className}`}
      aria-label="Klips home"
    >
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">K</span>
      Klips
    </a>
  );
}

/** A client-side link that still behaves like a normal link. */
export function Link({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Who's signed in, if anyone. */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ signed_in: false }));
  }, []);
  return me;
}

/** Sign-in buttons for the top right: "Your account" when signed in. */
export function AccountButtons() {
  const me = useMe();
  if (!me) return <div className="h-10" />;
  if (me.signed_in) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden rounded-full border border-ink-700 px-3 py-1.5 text-sm font-semibold text-brand-500 sm:inline">
          {(me.tokens ?? 0).toLocaleString()} tokens
        </span>
        <Link to="/account" className="btn btn-ghost text-sm">
          Account
        </Link>
        <a href="/studio/" className="btn btn-primary text-sm">
          Open Studio
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link to="/login" className="btn btn-ghost text-sm">
        Sign in
      </Link>
      <Link to="/signup" className="btn btn-primary text-sm">
        Create account
      </Link>
    </div>
  );
}
