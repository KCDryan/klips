/** Tiny API client for the Klips Worker. The browser's session cookie is sent automatically. */

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(String(data.error || response.statusText), response.status, data);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface Generation {
  id: string;
  status: string;
  tier: "tokens" | "free";
  source_name: string | null;
  clips_requested: number;
  clips_delivered: number | null;
  tokens_charged: number;
  platform: string | null;
  titles: string[];
  created_at: number;
  completed_at: number | null;
  device_name: string | null;
}

export interface LedgerEntry {
  delta: number;
  reason: string;
  balance_after: number;
  created_at: number;
}

export interface Subscription {
  plan: string;
  interval: string;
  status: string;
  tokens_per_period: number;
  current_period_end: number | null;
  cancel_at_period_end: number;
}

export interface FreeAllowance {
  free_clips_per_day: number;
  free_clips_left: number;
  free_resets_at: number;
}

export interface Account extends FreeAllowance {
  email: string;
  tokens: number;
  clips_available: number;
  has_billing: boolean;
  subscription: Subscription | null;
  generations: Generation[];
  ledger: LedgerEntry[];
}

export interface Onboarding {
  email: string;
  tokens: number;
  has_tokens: boolean;
  free_plan: boolean;
  engine_linked: boolean;
  engine_device: string | null;
  clips_made: number;
}

export interface Me extends Partial<FreeAllowance> {
  signed_in: boolean;
  email?: string;
  tokens?: number;
}

export const api = {
  me: () => request<Me>("/api/auth/me"),
  signUp: (email: string, password: string, licenseKey?: string) =>
    post<Me>("/api/auth/signup", { email, password, license_key: licenseKey || undefined }),
  signIn: (email: string, password: string) => post<Me>("/api/auth/login", { email, password }),
  signOut: () => post<{ ok: true }>("/api/auth/logout"),
  forgotPassword: (email: string) => post<{ ok: true }>("/api/auth/forgot", { email }),
  resetPassword: (token: string, password: string) => post<Me>("/api/auth/reset", { token, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<Me>("/api/auth/password", { current_password: currentPassword, new_password: newPassword }),

  account: () => request<Account>("/api/account"),
  onboarding: () => request<Onboarding>("/api/onboarding"),
  engineLink: () => post<{ app_key: string; email: string }>("/api/engine/link"),
  startFree: () => post<{ ok: true }>("/api/onboarding/free"),
  billingPortal: () => post<{ url: string }>("/api/account/portal"),

  buyTokens: (tokens: number) => post<{ url: string }>("/api/checkout/pack", { tokens }),
  subscribe: (plan: string, interval: "month" | "year") => post<{ url: string }>("/api/checkout/subscription", { plan, interval }),

  welcome: (sessionId: string) =>
    request<{ ready: boolean; email?: string; tokens?: number; added?: number; kind?: string; plan?: string | null }>(
      `/api/welcome?session_id=${encodeURIComponent(sessionId)}`,
    ),
};

/**
 * What someone was buying when we asked them to sign in, so checkout carries on straight after.
 * Kept in sessionStorage: it only lives for this tab.
 */
export type PendingPurchase = { kind: "pack"; tokens: number } | { kind: "plan"; plan: string; interval: "month" | "year" };

const PENDING_KEY = "klips.pendingPurchase";

export function setPendingPurchase(purchase: PendingPurchase | null): void {
  try {
    if (purchase) sessionStorage.setItem(PENDING_KEY, JSON.stringify(purchase));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage blocked: they'll just pick their tokens again */
  }
}

export function takePendingPurchase(): PendingPurchase | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingPurchase) : null;
  } catch {
    return null;
  }
}

/**
 * Start checkout; when signed out, remember the choice and send them to create an account.
 * Resolves true while the browser is leaving for Stripe, false when it went to sign-up instead.
 */
export async function startCheckout(purchase: PendingPurchase, goToSignUp: () => void): Promise<boolean> {
  try {
    const { url } =
      purchase.kind === "pack" ? await api.buyTokens(purchase.tokens) : await api.subscribe(purchase.plan, purchase.interval);
    window.location.href = url;
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setPendingPurchase(purchase);
      goToSignUp();
      return false;
    }
    throw e;
  }
}
