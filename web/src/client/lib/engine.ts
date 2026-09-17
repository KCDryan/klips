/**
 * Talking to Klips Engine on the customer's own computer, from pages on klips.pro.
 * The engine listens on 127.0.0.1 and only answers pages served from klips.pro.
 */
import { api } from "./api";

/** How to undo "Block" on the browser's local network prompt. */
export const UNBLOCK_HELP =
  "Your browser is blocking klips.pro from connecting to Klips Engine. Click the icon to the left of the web address, open Site settings, set Local network access to Allow, then reload this page.";

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
  // One port at a time: the engine almost always has the first, and a closed port fails instantly.
  for (const base of bases) {
    try {
      const info = await engineFetch<EngineInfo>(base, "/api/engine", {}, 2500);
      if (info.app === "klips-engine") return { base, info };
    } catch {
      /* not on this port */
    }
  }
  return null;
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

/** True when the browser has been told not to let klips.pro reach apps on this computer. */
export async function localAccessBlocked(): Promise<boolean> {
  // Only a public site can be blocked from reaching this computer; local development never is.
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return false;
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state === "denied";
    } catch {
      /* this browser doesn't know that permission name */
    }
  }
  return false;
}

/**
 * Apple Silicon or Intel, for Mac downloads. Browsers report every Mac as "Intel Mac OS X",
 * so read the graphics chip instead; when it can't tell, assume Apple Silicon (every Mac sold since 2021).
 */
export function macChip(): "apple" | "intel" {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    if (/Apple [AM]\d/i.test(renderer)) return "apple";
    if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return "intel";
  } catch {
    /* no WebGL */
  }
  return "apple";
}

export function computerOs(): "mac" | "windows" | "other" {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}
