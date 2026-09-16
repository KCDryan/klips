/**
 * Klips pricing, shared by the website, the Worker and the desktop app.
 * One token = 10 cents. Every finished vertical clip costs TOKENS_PER_CLIP tokens.
 */

export const TOKENS_PER_CLIP = 3;
export const CENTS_PER_TOKEN = 10;

/** One-off token packs: the slider on the pricing page. */
export const PACK = {
  minTokens: 10, // $1
  maxTokens: 1000, // $100
  stepTokens: 10,
  defaultTokens: 100, // $10
};

export type PlanId = "starter" | "creator" | "studio";
export type Interval = "month" | "year";

export interface Plan {
  id: PlanId;
  name: string;
  /** Tokens granted at the start of every billing month. */
  tokensPerMonth: number;
  monthlyCents: number;
  blurb: string;
  highlights: string[];
  popular?: boolean;
}

/** Yearly plans are paid upfront for 12 months at this discount. */
export const YEARLY_DISCOUNT = 0.2;

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    tokensPerMonth: 100,
    monthlyCents: 1000,
    blurb: "For posting a few clips a week.",
    highlights: ["100 tokens a month", "About 33 clips", "Unused tokens roll over"],
  },
  {
    id: "creator",
    name: "Creator",
    tokensPerMonth: 300,
    monthlyCents: 3000,
    blurb: "For a steady posting schedule.",
    highlights: ["300 tokens a month", "About 100 clips", "Unused tokens roll over", "Priority email support"],
    popular: true,
  },
  {
    id: "studio",
    name: "Studio",
    tokensPerMonth: 1000,
    monthlyCents: 10000,
    blurb: "For agencies and teams posting daily.",
    highlights: ["1,000 tokens a month", "About 333 clips", "Unused tokens roll over", "Priority email support"],
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** Price of a subscription charge: monthly, or 12 months upfront with the yearly discount. */
export function planCents(plan: Plan, interval: Interval): number {
  return interval === "year"
    ? Math.round(plan.monthlyCents * 12 * (1 - YEARLY_DISCOUNT))
    : plan.monthlyCents;
}

/** Tokens granted per charge: a year is paid upfront, so all 12 months of tokens arrive at once. */
export function planTokens(plan: Plan, interval: Interval): number {
  return interval === "year" ? plan.tokensPerMonth * 12 : plan.tokensPerMonth;
}

export function packCents(tokens: number): number {
  return tokens * CENTS_PER_TOKEN;
}

/** Clamp a requested pack size to the slider's range and step. */
export function normalizePackTokens(tokens: number): number {
  const stepped = Math.round(tokens / PACK.stepTokens) * PACK.stepTokens;
  return Math.max(PACK.minTokens, Math.min(PACK.maxTokens, stepped));
}

export function tokensForClips(clips: number): number {
  return Math.max(0, Math.floor(clips)) * TOKENS_PER_CLIP;
}

export function clipsForTokens(tokens: number): number {
  return Math.floor(tokens / TOKENS_PER_CLIP);
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
