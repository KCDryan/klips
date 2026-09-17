/**
 * Privacy-friendly analytics: counts page views (page, referring site, campaign) with no cookies or ids,
 * and remembers where a visitor first came from so a sign-up can be credited to that source.
 */

const FIRST_TOUCH_KEY = "klips.firstTouch";
let sentReferrer = false;

function campaignSource(params: URLSearchParams): string {
  return params.get("utm_source") || params.get("ref") || "";
}

/** Remember the first referring site and campaign, until this browser signs up. */
export function rememberFirstTouch(): void {
  try {
    if (localStorage.getItem(FIRST_TOUCH_KEY)) return;
    const params = new URLSearchParams(window.location.search);
    localStorage.setItem(
      FIRST_TOUCH_KEY,
      JSON.stringify({
        referrer: document.referrer,
        source: campaignSource(params),
        campaign: params.get("utm_campaign") || "",
        landing: window.location.pathname,
      }),
    );
  } catch {
    /* storage blocked: the sign-up just counts as direct */
  }
}

export function firstTouch(): Record<string, string> | undefined {
  try {
    return JSON.parse(localStorage.getItem(FIRST_TOUCH_KEY) || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

export function trackPageView(path: string): void {
  const params = new URLSearchParams(window.location.search);
  // The external referrer only belongs to the first page of the visit, not to later in-site navigation.
  const body = JSON.stringify({ path, referrer: sentReferrer ? "" : document.referrer, source: campaignSource(params) });
  sentReferrer = true;
  try {
    if (!navigator.sendBeacon?.("/api/t", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/t", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } });
    }
  } catch {
    /* analytics must never break the page */
  }
}
