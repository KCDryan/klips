import { describe, expect, it } from "vitest";

import { cleanPath, cleanTag, isBot, referrerHost, utcDay } from "./analytics";

describe("analytics helpers", () => {
  it("never keeps query strings or fragments", () => {
    expect(cleanPath("/reset?token=abc123")).toBe("/reset");
    expect(cleanPath("/Studio/#/job/1")).toBe("/studio/");
    expect(cleanPath("javascript:alert(1)")).toBe("/");
  });

  it("keeps only the referring site's hostname and ignores klips.pro itself", () => {
    expect(referrerHost("https://www.tiktok.com/@someone/video/1?x=y")).toBe("tiktok.com");
    expect(referrerHost("https://klips.pro/account")).toBe("");
    expect(referrerHost("not a url")).toBe("");
    expect(referrerHost("")).toBe("");
  });

  it("cleans campaign tags", () => {
    expect(cleanTag(" TikTok Bio! ")).toBe("tiktokbio");
    expect(cleanTag(undefined)).toBe("");
  });

  it("skips bots and link previewers", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot(null)).toBe(true);
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0 Safari/537.36")).toBe(false);
  });

  it("buckets by UTC day", () => {
    expect(utcDay(Date.UTC(2026, 8, 16, 23, 59) / 1000)).toBe("2026-09-16");
  });
});
