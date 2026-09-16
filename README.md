# Klips

Turn long videos into ready-to-post vertical clips. The desktop app does all the video work on the
customer's own computer using their own Claude Code subscription; the website sells tokens, holds the
licence keys and keeps each customer's history.

```
klips/
  web/    klips.pro — marketing site, checkout, account portal, and the API (Cloudflare Workers + D1 + Stripe)
  app/    the desktop app customers download (Python: Whisper, MediaPipe, OpenCV, ffmpeg)
```

## How the pieces fit

1. A customer buys tokens or a plan on klips.pro (Stripe Checkout).
2. The Worker creates their account and a licence key, shown on the welcome page.
3. They install the desktop app and paste the licence key.
4. Before each run the app reserves tokens (3 per clip). Clips that fail are refunded automatically.
5. The app reports the finished clip titles, so the account page shows their history.

Video never leaves the customer's machine. Only clip counts and titles are sent to klips.pro.

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
