# Going live with Kirby's Klips

Everything that needs your accounts, in order. Never paste keys or passwords into a chat. Each step says where
they go.

**What it costs to run: $0 a month.** Cloudflare (website, database, downloads), Resend (emails) and GitHub
(builds) all have free tiers that cover launch. Stripe charges only a fee per sale. The domain is already paid.
Step 4 is the only paid item, and it's optional.

## 1. Test the whole thing on a second computer (15 minutes)

On your other PC, in Chrome:

1. Go to https://klips.pro/start and sign in (or create an account).
2. Download and install Klips Engine. When Chrome asks to let klips.pro connect to devices on your network, click **Allow**.
3. Click **Install Claude Code**, then **Sign in to Claude**. Each step should say **Complete** by itself.
4. Open Klips Studio, choose **Free**, drop in a video, and make 2 clips.

If any step doesn't complete, note which one and what the screen says.

## 2. Switch Stripe to live payments

1. In Stripe, finish **Activate account** (business details and bank account).
2. Turn off **Test mode**.
3. **Developers → API keys**: reveal the live **Secret key** (`sk_live_...`).
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://klips.pro/api/stripe/webhook`
   - Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`).
5. **Settings → Billing → Customer portal**: click **Save** once. The live portal is off until you do.
6. Put both secrets on the website, pasting each when asked:
   ```bash
   cd ~/klips/web && npx wrangler secret put STRIPE_SECRET_KEY
   ```
   ```bash
   cd ~/klips/web && npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
7. Buy the smallest pack ($1) with a real card to confirm the tokens arrive, then refund yourself in Stripe.

## 3. Password-reset emails (Resend, free)

1. Sign up at https://resend.com with kcd.ryanc@gmail.com.
2. **Domains → Add domain → klips.pro**. Add the DNS records it shows in Cloudflare (**klips.pro → DNS → Add record**), then click **Verify** in Resend.
3. **API Keys → Create API key** (sending access), then:
   ```bash
   cd ~/klips/web && npx wrangler secret put RESEND_API_KEY
   ```
4. Test it at https://klips.pro/forgot. Emails come from `accounts@klips.pro`, and replies go to kcd.ryanc@gmail.com.

## 4. Optional, later: remove the "unverified developer" warnings (code signing, paid)

Skip this until sales justify it. Without it, Mac and Windows show a one-time warning when the engine is first
opened, and the setup checklist shows customers exactly which buttons to click. There's no free code-signing
option for a commercial app on either platform.

When you're ready, the build signs the installers automatically once these GitHub secrets exist. Add each secret from Terminal; the
command asks for the value, so it never lands in your shell history:

```bash
cd ~/klips && gh secret set NAME
```

### Mac: Apple Developer Program ($99 a year)

1. Enroll at https://developer.apple.com/programs/ (as an individual, or as Kirby Chan Digital).
2. Create a **Developer ID Application** certificate: in Xcode → Settings → Accounts → Manage Certificates, or at
   https://developer.apple.com/account/resources/certificates using a signing request from Keychain Access.
3. In Keychain Access, right-click that certificate → **Export** as `klips.p12` with a password.
4. Create an app-specific password at https://account.apple.com → Sign-In and Security → App-Specific Passwords.
5. Add the secrets:
   - `APPLE_CERTIFICATE_P12`: run `base64 -i klips.p12 | pbcopy`, then paste
   - `APPLE_CERTIFICATE_PASSWORD`: the export password
   - `APPLE_ID`: your Apple Account email
   - `APPLE_TEAM_ID`: shown at https://developer.apple.com/account under Membership
   - `APPLE_APP_PASSWORD`: the app-specific password
6. Delete `klips.p12` from your Mac.

### Windows: Azure Artifact Signing (about $10 a month)

1. In the Azure portal, create an **Artifact Signing** account and finish identity validation.
2. Create a **Public Trust** certificate profile.
3. Create an app registration (Microsoft Entra ID → App registrations), add a client secret, and give it the
   **Artifact Signing Certificate Profile Signer** role on the signing account (older Microsoft pages call it
   Trusted Signing Certificate Profile Signer).
4. Add the secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`
   (for example `https://eus.codesigning.azure.net/`), `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`.

After adding secrets, raise `APP_VERSION` in `app/clipper/pipeline.py` so a new signed release builds. Once
installers are signed, update the Mac and Windows install steps in `web/src/client/components/Checklist.tsx`,
since customers won't see the warnings any more.

## 5. Confirm with Anthropic

Anthropic's Claude Code terms say to contact sales if you're unsure whether your use is permitted. Send this from
https://www.anthropic.com/contact-sales:

> Hi, I run Kirby's Klips (https://klips.pro), a tool that turns long videos into short clips. Customers install our engine
> on their own computer. It calls the unmodified Claude Code CLI (`claude -p`) that the customer installed and signed
> into themselves with their own Pro or Max plan, to pick moments and write titles for their own videos. We never
> see, store or route their Claude credentials, and we don't charge for Claude usage: our tokens pay for our
> rendering software. We'd also offer customers the option to use their own Anthropic API key. Is this use
> permitted under your terms, and is there anything we should change in how we describe it? We say "connects to
> your own Claude Code" in plain text and don't use your logos. Thanks, [your name], Kirby Chan Digital

## 6. Add a demo clip to the landing page

Pick a clip you have the rights to show (your own face and words), then upload it with a still frame for the
poster:

```bash
cd ~/klips && ~/ai-clipper/.venv/bin/python scripts/upload_installer.py ~/Downloads/demo.mp4 ~/Downloads/demo-poster.jpg
```

The files must be named `demo.mp4` and `demo-poster.jpg`. The "A real clip, made by Kirby's Klips" section appears on the
landing page as soon as `demo.mp4` exists.

## Watching how it goes

```bash
~/klips/scripts/stats.py
```

This shows visits, sign-ups by source, the setup funnel, clips made and revenue. Add `?ref=tiktok` (or `?ref=`
any name) to links you share, and each source shows up separately.
