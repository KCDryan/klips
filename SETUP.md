# Launching Klips

Everything is written. These are the accounts and keys only you can create, in the order that works.
Budget about an hour for the first pass.

---

## 1. GitHub

```bash
cd ~/klips
gh repo create klips --private --source . --push     # or create it on github.com and add the remote
```

## 2. Cloudflare (the website and database)

```bash
cd ~/klips/web
npx wrangler login                 # opens your browser
npx wrangler d1 create klips       # prints a database_id
```

Paste that `database_id` into `web/wrangler.jsonc`, then create the tables:

```bash
npm run db:init:remote
```

## 3. Stripe (payments)

1. Create an account at dashboard.stripe.com and stay in **test mode** for now.
2. **Developers → API keys**: copy the **secret key** (`sk_test_...`).
3. Give it to the Worker:
   ```bash
   cd ~/klips/web
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
4. **Developers → Webhooks → Add endpoint**: `https://klips.pro/api/stripe/webhook`, subscribed to:
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy that endpoint's **signing secret** (`whsec_...`):
   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

Klips creates prices on the fly from `web/src/shared/pricing.ts`, so there's nothing to set up in the
Stripe product catalogue.

## 4. Deploy and connect the domain

```bash
cd ~/klips/web
npm run deploy
```

In the Cloudflare dashboard: **Workers & Pages → klips → Settings → Domains & Routes → Add custom domain**
→ `klips.pro`. (Add the domain to Cloudflare first if it isn't there yet.)

## 5. Automatic deploys from GitHub

In the repo: **Settings → Secrets and variables → Actions**, add:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard URL, or `npx wrangler whoami` |

After that, every push to `main` that touches `web/` deploys itself.

## 6. Test the whole purchase flow

With Stripe still in test mode, buy tokens on your own site using card `4242 4242 4242 4242`,
any future expiry, any CVC. Check that:

- the welcome page shows a licence key,
- the key signs you in at `/account` and shows the tokens,
- pasting the key into the desktop app activates it,
- a run deducts 3 tokens per clip and shows up under "Your clips".

## 7. Go live

1. Stripe → toggle off test mode → copy the **live** secret key and a new webhook signing secret.
2. Re-run both `wrangler secret put` commands with the live values.
3. Publish the desktop installers (see below) and point the download links at them:
   `DOWNLOAD_MAC_URL` and `DOWNLOAD_WINDOWS_URL` in `web/wrangler.jsonc`.

---

## Publishing the desktop app

`.github/workflows/build-app.yml` builds a Mac `.dmg` and a Windows `.exe` when you push a tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The build attaches both files to a GitHub release. **This workflow hasn't been run yet** — packaging
Python apps with MediaPipe and OpenCV usually needs a round or two of fixing. Run it, read the log,
and I'll fix whatever it reports.

Until then, customers can run the app from source with `start.command` (Mac) or `start.bat` (Windows),
which is what `app/README.md` describes.

---

## What each secret does

| Name | Lives in | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | Cloudflare Worker secret | Creating checkout sessions and reading subscriptions |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare Worker secret | Proving a webhook really came from Stripe before adding tokens |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Deploying from CI |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Deploying from CI |

No key is ever stored in the repository, and the desktop app never sees a Stripe key.

## Costs to expect

- **Cloudflare Workers Paid**: $5/month covers the site, the API and the database at this scale.
- **Stripe**: 2.9% + 30¢ per successful charge (US/Canada cards).
- **Your own Claude subscription**: only needed on your machine, for your own clipping. Customers use theirs.
