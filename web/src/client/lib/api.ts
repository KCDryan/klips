/** Tiny API client for the Klips Worker. */

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, options: RequestInit & { licenseKey?: string } = {}): Promise<T> {
  const { licenseKey, ...init } = options;
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (licenseKey) headers.set("x-klips-key", licenseKey);
  const response = await fetch(path, { ...init, headers });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(String(data.error || response.statusText), response.status, data);
  }
  return data as T;
}

export interface Generation {
  id: string;
  status: string;
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

export interface Account {
  email: string;
  tokens: number;
  clips_available: number;
  license_key: string;
  has_billing: boolean;
  subscription: Subscription | null;
  generations: Generation[];
  ledger: LedgerEntry[];
}

export const api = {
  account: (licenseKey: string) => request<Account>("/api/account", { licenseKey }),

  billingPortal: (licenseKey: string) =>
    request<{ url: string }>("/api/account/portal", { method: "POST", licenseKey, body: "{}" }),

  buyTokens: (tokens: number, email?: string) =>
    request<{ url: string }>("/api/checkout/pack", {
      method: "POST",
      body: JSON.stringify({ tokens, email }),
    }),

  subscribe: (plan: string, interval: "month" | "year", email?: string) =>
    request<{ url: string }>("/api/checkout/subscription", {
      method: "POST",
      body: JSON.stringify({ plan, interval, email }),
    }),

  welcome: (sessionId: string) =>
    request<{ email?: string; license_key?: string; tokens?: number; pending?: boolean }>(
      `/api/welcome?session_id=${encodeURIComponent(sessionId)}`,
    ),
};

const STORAGE_KEY = "klips.licenseKey";

export function savedLicenseKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveLicenseKey(key: string): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing: the key just won't be remembered */
  }
}
