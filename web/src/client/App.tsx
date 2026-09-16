import { useEffect, useState } from "react";

import { Account } from "./pages/Account";
import { Landing } from "./pages/Landing";
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

  if (path.startsWith("/welcome")) return <Welcome />;
  if (path.startsWith("/account")) return <Account />;
  return <Landing />;
}
