import { TOKENS_PER_CLIP } from "../../shared/pricing";
import { navigate } from "../App";

const UPDATED = "16 September 2026";

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <button type="button" onClick={() => navigate("/")} className="flex items-center gap-2 font-extrabold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">K</span>
            Klips
          </button>
          <button type="button" className="text-sm text-ink-500 hover:text-ink-100" onClick={() => navigate("/")}>
            Back to klips.pro
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-ink-500">Last updated {UPDATED}</p>
        <div className="mt-8 space-y-6 text-ink-300 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-ink-100 [&_li]:ml-5 [&_li]:list-disc">
          {children}
        </div>
      </main>
    </div>
  );
}

export function Terms() {
  return (
    <Page title="Terms of service">
      <p>
        Klips is software you run on your own computer, sold by Kirby Chan Digital. Buying tokens or a plan means you
        agree to these terms. If anything here doesn't work for you, email support@klips.pro before you buy.
      </p>

      <h2>What you're buying</h2>
      <p>
        A licence to use the Klips desktop app, plus tokens that let it produce clips. One finished vertical clip costs{" "}
        {TOKENS_PER_CLIP} tokens. Your licence is for you or your business; don't share the key or resell access.
      </p>

      <h2>What you need</h2>
      <p>
        A Mac or Windows computer and your own Claude subscription with Claude Code. Klips uses your Claude account to
        choose clips and write titles, so Anthropic's terms and usage limits apply to that part. We aren't affiliated
        with Anthropic, and we can't fix or refund problems caused by your Claude account.
      </p>

      <h2>Tokens</h2>
      <ul>
        <li>Tokens bought as a one-off pack don't expire.</li>
        <li>Plan tokens are added at the start of each billing period and roll over while the plan is active.</li>
        <li>You're charged when a run starts and refunded for any clip that doesn't finish.</li>
        <li>Tokens have no cash value and can't be transferred between accounts.</li>
      </ul>

      <h2>Refunds</h2>
      <p>
        If Klips doesn't work on your computer, email support@klips.pro within 14 days of your first purchase and we'll
        refund it in full, as long as you've used fewer than 30 tokens. Beyond that we refund unused tokens at our
        discretion. Subscriptions can be cancelled any time from your account page; cancelling stops future charges and
        yearly plans aren't refunded for months already paid.
      </p>

      <h2>Your content</h2>
      <p>
        Your videos stay on your computer. You're responsible for having the right to clip and publish whatever you
        process, including recordings of calls with other people. Don't use Klips for anything illegal.
      </p>

      <h2>Fair use of your licence</h2>
      <p>
        Klips runs on your machine, so we rely on the licence check being honest. Sharing keys, tampering with the app
        to skip token checks, or reselling clips as a competing service ends the licence without a refund.
      </p>

      <h2>No guarantees</h2>
      <p>
        Klips is provided as is. Clip quality depends on your footage, and results vary. We're not liable for lost
        income, lost data, or anything beyond the amount you paid us in the last 12 months.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; the date above shows when. Meaningful changes will be emailed to the address on your
        account. Ontario, Canada law applies.
      </p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <p>Short version: your videos never reach us, and we keep the least we can.</p>

      <h2>What we store</h2>
      <ul>
        <li>Your email address, from checkout.</li>
        <li>Your licence key, token balance and the history of token movements.</li>
        <li>For each run: the video's file name, its length, how many clips you asked for, how many were delivered, the clip titles, and the name of the computer that made them.</li>
        <li>Payment records from Stripe: amounts, dates and card brand. We never see your full card number.</li>
      </ul>

      <h2>What we never receive</h2>
      <ul>
        <li>Your video or audio files.</li>
        <li>Your transcripts. Those go from your computer to Anthropic through your own Claude account.</li>
        <li>Your finished clips.</li>
      </ul>

      <h2>Who else is involved</h2>
      <p>
        Stripe processes payments. Cloudflare hosts this site and its database. Anthropic provides Claude through your
        own subscription. Each has its own privacy policy.
      </p>

      <h2>Your choices</h2>
      <p>
        Email support@klips.pro to get a copy of your data or to delete your account. Deleting removes your account,
        licence keys and history; we keep payment records where tax law requires it.
      </p>

      <h2>Cookies</h2>
      <p>
        This site stores your licence key in your browser so you stay signed in. No advertising or tracking cookies.
      </p>
    </Page>
  );
}
