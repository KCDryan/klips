/**
 * Talking to Klips Engine on the customer's own computer, from pages on klips.pro.
 * The engine listens on 127.0.0.1 and only answers pages served from klips.pro.
 */
import { api } from "./api";

export const ENGINE_PORTS = [47813, 47814, 47815, 47816, 47817];

export interface EngineInfo {
  app: "klips-engine";
  version: string;
  platform: "mac" | "windows" | "linux";
  device: string;
  linked: boolean;
  account: string;
}

export interface ClaudeStatus {
  backend: string;
  ready: boolean;
  installed?: boolean;
  logged_in?: boolean;
  platform?: string;
  install_command?: string;
  message?: string;
  install?: { state: "idle" | "running" | "done" | "failed"; error?: string; log?: string };
}

export interface Engine {
  base: string;
  info: EngineInfo;
}

async function engineFetch<T>(base: string, path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error || response.statusText));
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The engine running on this computer, or null. */
export async function findEngine(): Promise<Engine | null> {
  const override = new URLSearchParams(window.location.search).get("engine");
  const bases = override ? [override.replace(/\/$/, "")] : ENGINE_PORTS.map((port) => `http://127.0.0.1:${port}`);
  try {
    return await Promise.any(
      bases.map(async (base) => {
        const info = await engineFetch<EngineInfo>(base, "/api/engine", {}, 2500);
        if (info.app !== "klips-engine") throw new Error("not Klips");
        return { base, info };
      }),
    );
  } catch {
    return null;
  }
}

/** Connect the engine to the account signed in on klips.pro (no password needed on the engine). */
export async function linkEngine(engine: Engine, email: string): Promise<void> {
  if (engine.info.linked && engine.info.account === email) return;
  const { app_key } = await api.engineLink();
  await engineFetch(engine.base, "/api/license/link", { method: "POST", body: JSON.stringify({ app_key }) }, 20000);
}

export const claudeStatus = (engine: Engine) => engineFetch<ClaudeStatus>(engine.base, "/api/claude/status", {}, 30000);
export const installClaude = (engine: Engine) =>
  engineFetch<ClaudeStatus>(engine.base, "/api/claude/install", { method: "POST" }, 30000);
export const openClaudeSignIn = (engine: Engine) =>
  engineFetch<{ ok: true }>(engine.base, "/api/claude/sign-in", { method: "POST" }, 40000);

export function computerOs(): "mac" | "windows" | "other" {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}
