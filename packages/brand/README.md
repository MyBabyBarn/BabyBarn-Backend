# Baby Barn brand & document system

Single source of truth for **transactional emails**, **admin PDFs**, and shared **design tokens** used across the platform.

## Structure

```
packages/brand/
  brand.tokens.json     # Colors, typography, legal copy, contact
  email/
    layout.js           # Responsive HTML shell
    components.js       # Header, footer, CTA, order summary, tables, badges
    templates.js        # All transactional template bodies
  pdf/
    layout.js           # Branded header/footer helpers (no pdfkit import)
```

## Usage (backend)

```js
import { renderBrandedEmailTemplate } from '../../packages/brand/index.js';
import { getBrandContext } from '../lib/brand-context.js';

const brand = getBrandContext();
const { subject, html, text } = renderBrandedEmailTemplate('order-confirmation', context, brand);
```

PDF builders live in `backend/services/pdf/branded-documents.js` (uses backend’s `pdfkit` install) and import layout from `packages/brand/pdf/layout.js`.

## Environment overrides

| Variable | Purpose |
|----------|---------|
| `BRAND_SUPPORT_EMAIL` | Footer / support link (default `hello@babybarn.co`) |
| `BRAND_LOGO_PATH` | Path on `PUBLIC_URL` for email logo image |
| `PUBLIC_URL` | Base URL for hosted logo asset |
| `CUSTOMER_FRONTEND_URL` | CTA links in customer emails |

## Email templates

| ID | Purpose |
|----|---------|
| `verify-email` | Account verification |
| `forgot-password` | Password reset |
| `welcome` | Post-verification welcome |
| `otp` | One-time code |
| `order-confirmation` | Paid order (with line summary) |
| `order-tracking` | Shipped + tracking |
| `order-cancelled` | Cancellation notice |
| `refund-confirmation` | Refund initiated |
| `return-status` | Return workflow update |
| `store-credit-update` | Wallet credit |
| `access-purchase` / `access-renewal` / `access-renewal-reminder` / `access-expired` | Farmhouse Friends membership |
| `team-invite` | Admin team onboarding |
| `contact-inquiry-admin` | Storefront contact form |

## Frontends

Import tokens in Next apps via `theme/brand.tokens.json` (copied from this file — Turbopack cannot import outside each app root). When you change colors here, update `customer-fe/theme/brand.tokens.json` and `admin-fe/theme/brand.tokens.json` too.

## Not yet in this package

- Marketing / abandoned-cart campaigns (no sender wired)
- Stripe-hosted receipts
- UPS label PDFs (carrier-generated)
- Admin CSV exports

Add new templates in `email/templates.js` and register senders in the appropriate service.
