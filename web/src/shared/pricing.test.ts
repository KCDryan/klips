import { describe, expect, it } from "vitest";

import {
  FREE_CLIPS_PER_DAY,
  freeDayStart,
  PACK,
  TOKENS_PER_CLIP,
  YEARLY_DISCOUNT,
  clipsForTokens,
  formatUsd,
  normalizePackTokens,
  packCents,
  planById,
  planCents,
  planTokens,
  tokensForClips,
} from "./pricing";

describe("tokens", () => {
  it("charges 3 tokens per clip", () => {
    expect(TOKENS_PER_CLIP).toBe(3);
    expect(tokensForClips(1)).toBe(3);
    expect(tokensForClips(10)).toBe(30); // 10 clips from one video
  });

  it("never charges for a negative or fractional clip count", () => {
    expect(tokensForClips(-5)).toBe(0);
    expect(tokensForClips(2.9)).toBe(6);
  });

  it("converts a balance into whole clips", () => {
    expect(clipsForTokens(100)).toBe(33);
    expect(clipsForTokens(2)).toBe(0);
  });
});

describe("token packs", () => {
  it("prices the slider ends at $1 and $100", () => {
    expect(packCents(PACK.minTokens)).toBe(100);
    expect(packCents(PACK.maxTokens)).toBe(10_000);
    expect(packCents(100)).toBe(1_000); // the $10 default
  });

  it("clamps and snaps whatever the browser sends", () => {
    expect(normalizePackTokens(3)).toBe(PACK.minTokens);
    expect(normalizePackTokens(99_999)).toBe(PACK.maxTokens);
    expect(normalizePackTokens(137)).toBe(140);
  });
});

describe("plans", () => {
  it("bills monthly plans at their list price", () => {
    const starter = planById("starter")!;
    expect(planCents(starter, "month")).toBe(1_000);
    expect(planTokens(starter, "month")).toBe(100);
  });

  it("gives 12 months of tokens upfront for a year, at a 20% discount", () => {
    const creator = planById("creator")!;
    expect(YEARLY_DISCOUNT).toBe(0.2);
    expect(planCents(creator, "year")).toBe(Math.round(3_000 * 12 * 0.8)); // $288 instead of $360
    expect(planTokens(creator, "year")).toBe(3_600);
  });

  it("keeps every plan's price per token at or below the pack price", () => {
    for (const plan of ["starter", "creator", "studio"] as const) {
      const p = planById(plan)!;
      expect(planCents(p, "month") / planTokens(p, "month")).toBeLessThanOrEqual(10);
    }
  });

  it("ignores unknown plan ids", () => {
    expect(planById("enterprise")).toBeUndefined();
  });
});

describe("formatting", () => {
  it("drops cents when a price is whole dollars", () => {
    expect(formatUsd(1_000)).toBe("$10");
    expect(formatUsd(9_600)).toBe("$96");
    expect(formatUsd(2_850)).toBe("$28.50");
  });
});

describe("free plan", () => {
  it("gives 10 clips a day", () => {
    expect(FREE_CLIPS_PER_DAY).toBe(10);
  });

  it("starts each free day at midnight UTC", () => {
    const noonUtc = Date.UTC(2026, 8, 16, 12, 0, 0) / 1000;
    expect(freeDayStart(noonUtc)).toBe(Date.UTC(2026, 8, 16) / 1000);
    expect(freeDayStart(Date.UTC(2026, 8, 17) / 1000)).toBe(Date.UTC(2026, 8, 17) / 1000);
    expect(freeDayStart(Date.UTC(2026, 8, 17) / 1000 - 1)).toBe(Date.UTC(2026, 8, 16) / 1000);
  });
});
