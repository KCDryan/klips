import { useEffect, useState } from "react";

import { Account } from "./pages/Account";
import { Auth } from "./pages/Auth";
import { Landing } from "./pages/Landing";
import { Privacy, Terms } from "./pages/Legal";
import { Start } from "./pages/Start";
import { Welcome } from "./pages/Welcome";

/** Minimal router: the Worker serves index.html for every page, so we read the path here. */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);

  if (path.startsWith("/studio")) {
    // The studio is its own page (public/studio). Only reached here in local development.
    window.location.replace(`/studio/index.html${window.location.search}${window.location.hash}`);
    return null;
  }
  if (path.startsWith("/start")) return <Start />;
  if (path.startsWith("/welcome")) return <Welcome />;
  if (path.startsWith("/account")) return <Account />;
  if (path.startsWith("/login")) return <Auth key="login" mode="login" />;
  if (path.startsWith("/signup")) return <Auth key="signup" mode="signup" />;
  if (path.startsWith("/forgot")) return <Auth key="forgot" mode="forgot" />;
  if (path.startsWith("/reset")) return <Auth key="reset" mode="reset" />;
  if (path.startsWith("/terms")) return <Terms />;
  if (path.startsWith("/privacy")) return <Privacy />;
  return <Landing />;
}
