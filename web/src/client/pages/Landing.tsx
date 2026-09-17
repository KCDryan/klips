import { useEffect, useState } from "react";

import { BRAND, COMPANY, FOUNDER, PATREON_URL } from "../../shared/brand";
import { FREE_CLIPS_PER_DAY, TOKENS_PER_CLIP } from "../../shared/pricing";
import { PlanCards, TokenSlider } from "../components/Pricing";
import { AccountButtons, Link, Logo } from "../components/SiteHeader";
import { api } from "../lib/api";

const STEPS = [
  {
    title: "Create your account",
    body: "Sign up, pick your tokens, and a checklist walks you through the rest.",
  },
  {
    title: "Add Klips Engine",
    body: "A one-time install that runs quietly in the background, so your own computer does the video work.",
  },
  {
    title: "Connect your Claude Code",
    body: "Klips uses the Claude subscription you already pay for. Two clicks from the checklist.",
  },
  {
    title: "Clip in your browser",
    body: "Open Klips Studio, drop in a long video, and edit, download and post your clips right there.",
  },
];

const FEATURES = [
  {
    title: "Claude picks the moments",
    body: "It reads the whole transcript and keeps moments with a real hook and a payoff, then scores each one.",
  },
  {
    title: "Follows whoever is talking",
    body: "The frame tracks the speaker, splits the screen when two people talk over each other, and cuts cleanly.",
  },
  {
    title: "Zoom screen shares handled",
    body: "When you share your screen, Klips stacks the screen above your webcam instead of shrinking everything.",
  },
  {
    title: "Captions people actually read",
    body: "Five styles, word-by-word highlighting, emphasis on power words, all clear of the app's buttons.",
  },
  {
    title: "Titles, descriptions, hashtags",
    body: "Written per clip, with your own link added to every description. Copy and post.",
  },
  {
    title: "Edit before you export",
    body: "Trim on a waveform, cut words from the transcript, swap caption styles, re-render one clip.",
  },
];

const FAQ = [
  {
    q: `What do I need to run ${BRAND}?`,
    a: "Chrome or Edge on a Mac or Windows computer, plus a Claude Pro or Max subscription. You use Klips in your browser; the video work runs on your own computer, so nothing uploads to the cloud and there are no cloud processing fees.",
  },
  {
    q: "Do I have to download anything?",
    a: "Just once: Klips Engine, a small background helper that lets the website use your computer's power. After that everything happens at klips.pro/studio. The setup checklist walks you through it in a few minutes.",
  },
  {
    q: "Why do I connect my own Claude?",
    a: "Writing the clip picks, titles and descriptions is the only part that needs AI. Using your own Claude account keeps your Klips tokens cheap, and your transcripts stay between you and Anthropic.",
  },
  {
    q: "Is there a free plan?",
    a: `Yes. Every account gets ${FREE_CLIPS_PER_DAY} free clips a day with every feature, marked with a small klips.pro watermark. The count resets at midnight UTC. Paid clips have no watermark, and you can remove the watermark from any free clip later for ${TOKENS_PER_CLIP} tokens.`,
  },
  {
    q: "What does a token buy?",
    a: `${TOKENS_PER_CLIP} tokens make one finished vertical clip. Ask for 10 clips from a video and it costs ${TOKENS_PER_CLIP * 10} tokens. Tokens from a one-off purchase never expire.`,
  },
  {
    q: "What if a clip fails?",
    a: "You're only charged for clips that finish. Anything that fails, or any clip Klips couldn't make, is refunded to your balance automatically.",
  },
  {
    q: "Does my video get uploaded?",
    a: "Not to us. When you drop a video into Klips Studio, it goes from your browser straight to Klips Engine on the same computer, and your clips are saved there. We only receive clip titles and counts so you can see your history.",
  },
  {
    q: "Can I cancel a plan?",
    a: "Yes, from your account page, and you keep any tokens you've already been given. Yearly plans are paid upfront for 12 months.",
  },
  {
    q: `Can I use ${BRAND} on more than one computer?`,
    a: "Yes. Install Klips Engine on each computer and open klips.pro/studio there. Your tokens and history follow your account.",
  },
];

/** A real clip made with Klips, shown once one has been uploaded (scripts/upload_installer.py demo.mp4). */
function Demo() {
  const [demo, setDemo] = useState<{ video: boolean; poster: boolean } | null>(null);

  useEffect(() => {
    api.demo().then(setDemo).catch(() => setDemo(null));
  }, []);

  if (!demo?.video) return null;
  return (
    <section id="demo" className="mx-auto max-w-6xl px-5 py-20">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">A real clip, made by {BRAND}</h2>
          <p className="mt-3 max-w-lg text-ink-300">
            Straight out of Klips from a long recording, with no manual editing. Claude picked the moment and wrote the
            hook, the frame follows the speaker, and the captions highlight each word as it's said.
          </p>
          <ul className="mt-6 space-y-2 text-ink-300">
            {["Moment picked and scored by Claude", "Reframed to vertical on the speaker", "Word-by-word captions and a hook", "Title, description and hashtags written for you"].map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-brand-500">✓</span>
                {line}
              </li>
            ))}
          </ul>
          <Link to="/signup" className="btn btn-primary mt-8">
            Make yours free
          </Link>
        </div>
        <div className="mx-auto w-[280px] overflow-hidden rounded-[2rem] border border-ink-700 bg-black shadow-2xl shadow-black/60">
          <video
            src="/media/demo.mp4"
            poster={demo.poster ? "/media/demo-poster.jpg" : undefined}
            className="aspect-[9/16] w-full"
            controls
            playsInline
            preload="metadata"
          />
        </div>
      </div>
    </section>
  );
}

/** A small mock of the app's output: shared screen on top, webcam and captions below. */
function PhoneMock() {
  return (
    <div className="relative mx-auto w-[260px] rise">
      <div className="overflow-hidden rounded-[2rem] border border-ink-700 bg-ink-900 shadow-2xl shadow-black/60">
        <div className="h-[72%] bg-gradient-to-b from-ink-800 to-ink-850 p-3">
          <div className="h-3 w-24 rounded bg-ink-700" />
          <div className="mt-3 space-y-2">
            {[90, 70, 80, 55, 75].map((w, i) => (
              <div key={i} className="h-2 rounded bg-ink-700" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="mt-4 h-20 rounded-lg bg-ink-800" />
        </div>
        <div className="relative h-[28%] bg-gradient-to-b from-[#3a4a3f] to-[#232a26] p-3">
          <div className="absolute inset-x-0 -top-6 text-center text-[15px] font-black leading-tight">
            <span className="rounded bg-black/30 px-1 text-brand-500">THIS ONE</span>{" "}
            <span className="rounded bg-black/30 px-1">LINE</span>
          </div>
          <div className="mx-auto mt-4 h-12 w-12 rounded-full bg-[#c89a78]" />
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-800/80 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Logo />
          <nav className="hidden items-center gap-7 text-sm text-ink-300 md:flex">
            <a href="#how" className="hover:text-ink-100">How it works</a>
            <a href="#features" className="hover:text-ink-100">Features</a>
            <a href="#pricing" className="hover:text-ink-100">Pricing</a>
            <a href="#faq" className="hover:text-ink-100">FAQ</a>
          </nav>
          <AccountButtons />
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="aurora" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 md:grid-cols-2 md:py-28">
          <div className="rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs font-semibold text-ink-300">
              <span className="h-2 w-2 rounded-full bg-brand-500" />
              By {FOUNDER} · runs in your browser, powered by your own computer
            </span>
            <h1 className="mt-6 text-5xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
              One long video.
              <br />
              A week of shorts.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-ink-300">
              {BRAND} turns podcasts, interviews and Zoom calls into vertical clips that are captioned, reframed and
              ready to post. You work in your browser; your own computer does the heavy lifting, not a rented cloud queue.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup" className="btn btn-primary text-base">Start free</Link>
              <a href="#how" className="btn btn-ghost text-base">See how it works</a>
            </div>
            <p className="mt-4 text-sm text-ink-500">
              {FREE_CLIPS_PER_DAY} free clips a day · no card needed · your footage never leaves your computer
            </p>
          </div>
          <PhoneMock />
        </div>
      </section>

      <Demo />

      <section id="how" className="border-y border-ink-800 bg-ink-900/40">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Four steps, then it's yours</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-4">
            {STEPS.map((step, i) => (
              <div key={step.title} className="card p-6">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 font-bold text-ink-950">
                  {i + 1}
                </div>
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-ink-300">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Everything an editor would do</h2>
        <p className="mt-3 max-w-2xl text-ink-300">
          Klips does the work a short-form editor charges for: choosing moments, framing the shot, writing the copy.
        </p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card p-6">
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-ink-300">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="border-y border-ink-800 bg-ink-900/40">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Pay for clips, not seats</h2>
          <p className="mt-3 max-w-2xl text-ink-300">
            Start free with {FREE_CLIPS_PER_DAY} watermarked clips a day. Buy a pack of tokens for clips without a
            watermark, or take a plan if you post every week.
          </p>
          <div className="card mt-8 flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <div className="text-lg font-semibold">Free</div>
              <p className="mt-1 text-ink-300">
                {FREE_CLIPS_PER_DAY} clips every day with a small klips.pro watermark. Every feature included, no card needed.
              </p>
            </div>
            <Link to="/signup" className="btn btn-ghost">
              Start free
            </Link>
          </div>
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <TokenSlider />
            <div>
              <PlanCards />
            </div>
          </div>
        </div>
      </section>

      <section id="kirby" className="border-y border-ink-800 bg-ink-900/40">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-20 md:grid-cols-[auto_1fr]">
          <div className="grid h-40 w-40 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-5xl font-black text-ink-950 shadow-2xl shadow-black/50">
            KC
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-500">Made by {FOUNDER}</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">Built for the videos Kirby actually makes</h2>
            <p className="mt-4 max-w-2xl text-ink-300">
              {BRAND} started as the tool {FOUNDER} uses to turn long Zoom calls and recordings into shorts, with the
              screen shares, webcam layouts and posting copy handled. Now it's yours too: the same clips, made on your
              own computer, with {FREE_CLIPS_PER_DAY} free every day.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/signup" className="btn btn-primary">
                Start free
              </Link>
              <a href={PATREON_URL} target="_blank" rel="noopener" className="btn btn-ghost">
                Follow Kirby on Patreon
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-5 py-20">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Questions</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map((item) => (
            <details key={item.q} className="card group p-5">
              <summary className="cursor-pointer list-none font-semibold marker:content-none">
                <span className="mr-2 text-brand-500 group-open:hidden">+</span>
                <span className="mr-2 hidden text-brand-500 group-open:inline">–</span>
                {item.q}
              </summary>
              <p className="mt-3 text-ink-300">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-10 text-sm text-ink-500">
          <Logo />
          <p>
            © {new Date().getFullYear()} {BRAND} by {COMPANY} · klips.pro
          </p>
          <div className="flex flex-wrap gap-5">
            <Link to="/account" className="hover:text-ink-100">
              Your account
            </Link>
            <Link to="/terms" className="hover:text-ink-100">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-ink-100">
              Privacy
            </Link>
            <a href="mailto:kcd.ryanc@gmail.com" className="hover:text-ink-100">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
