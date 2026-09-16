# Klips

Turn long videos into ready-to-post vertical clips. Customers use Klips Studio in their browser at
klips.pro/studio; Klips Engine, a background service on their own computer, does all the video work with
their own Claude Code subscription. The website sells tokens, runs accounts and keeps each customer's history.

```
klips/
  web/    klips.pro: marketing site, checkout, accounts, setup checklist, Klips Studio (web/public/studio)
          and the API (Cloudflare Workers + D1 + R2 + Stripe)
  app/    Klips Engine, installed once on the customer's computer (Python: Whisper, MediaPipe, OpenCV, ffmpeg)
```

## How the pieces fit

1. A customer creates an account (email and password) and buys tokens or a plan (Stripe Checkout).
2. The setup checklist at /start walks them through installing Klips Engine and connecting Claude Code;
   each step ticks itself off.
3. They open klips.pro/studio. The page finds the engine on 127.0.0.1:47813 and links it to their account.
4. Before each run the engine reserves tokens (3 per clip). Clips that fail are refunded automatically.
5. The engine reports the finished clip titles, so the account page shows their history.

Video goes from the browser to the engine on the same computer and never reaches klips.pro. The engine only
answers requests from klips.pro pages (Origin check) addressed to 127.0.0.1 or localhost (Host check).

## Website (web/)

```bash
cd web
npm install
npm run dev          # local site + API at http://localhost:5173
npm run typecheck
npm run test
```

First-time setup on Cloudflare:

```bash
npx wrangler login
npx wrangler d1 create klips           # paste the id into wrangler.jsonc
npm run db:init                        # local database
npm run db:init:remote                 # production database
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npm run deploy
```

Then in Stripe, add a webhook to `https://klips.pro/api/stripe/webhook` for:
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`,
`customer.subscription.deleted`.

Pricing lives in one file, `web/src/shared/pricing.ts`: tokens per clip, the slider range and the plans.

## Desktop app (app/)

```bash
cd app
./start.command      # macOS
start.bat            # Windows
```

See `app/README.md` for what it does and how it's built.

## Environment

| Secret | Where | What it's for |
|---|---|---|
| `STRIPE_SECRET_KEY` | Worker secret | Creating checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | Verifying Stripe webhooks |
| `KLIPS_API` | Desktop app env (optional) | Point the app at a local API while testing |
