import { describe, expect, it } from "vitest";

import { hashPassword, isValidEmail, normalizeEmail, passwordProblem, readCookie, sessionCookie, verifyPassword } from "./auth";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("rejects missing or malformed hashes", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "plain-text")).toBe(false);
    expect(await verifyPassword("anything", "pbkdf2-sha256$0$AAAA$AAAA")).toBe(false);
  });

  it("asks for a reasonable password length", () => {
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("x".repeat(201))).toMatch(/too long/);
    expect(passwordProblem("longenough")).toBeNull();
  });
});

describe("emails and cookies", () => {
  it("normalises and validates emails", () => {
    expect(normalizeEmail("  Kirby@Example.COM ")).toBe("kirby@example.com");
    expect(isValidEmail("kirby@example.com")).toBe(true);
    expect(isValidEmail("kirby@example")).toBe(false);
    expect(isValidEmail("no spaces@example.com")).toBe(false);
  });

  it("writes a locked-down session cookie and reads it back", () => {
    const cookie = sessionCookie("abc123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const request = new Request("https://klips.pro", { headers: { cookie: "other=1; klips_session=abc123" } });
    expect(readCookie(request, "klips_session")).toBe("abc123");
    expect(readCookie(request, "missing")).toBe("");
  });
});
