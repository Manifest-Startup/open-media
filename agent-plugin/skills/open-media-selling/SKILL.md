---
name: open-media-selling
description: "Help a person sell and earn on Open Media: list a product, service, app or event, edit or rate listings, publish a paid post, turn tips on, set up payouts with Stripe, and run an ONDC store. Use when a person wants to sell something, list an event, get paid, take tips or check how their listing is doing."
---

# Selling on Open Media

Listings are public posts with structured details. They go live at once and are checked in the background against https://api.openmedia.site/policies/listings. Everything here needs the person's account (`https://api.openmedia.site/account/mcp`) and their yes for the exact listing first.

## When to use this skill

- "Sell my desk for $120", "list my design service", "post my event on Saturday".
- "Fix the price on my listing", "how is my listing doing?"
- "Let people tip me", "set up payouts", "make this post paid".
- "Open my ONDC store".

## Steps

1. Draft the listing with the person: what it is, price and currency, where, and for an event the date and the official page. Apps are listed as a link to their official page, never a file.
2. `publish_listing` (or `publish_job` for a job) after they agree. `update_listing` changes it later. `get_listing_checks` shows the checks it passed or why it needs fixing; if Open Media messaged them about it, tell them to read that message.
3. Payments go straight to the person: `get_payment_setup`, then `start_payout_setup` returns a Stripe link for them to open; `refresh_payout_setup` checks again when they are done. `set_tips` turns tips on or off. Removing a wallet: `remove_wallet`; linking one needs their own signature in the app.
4. `publish_paid_post` sells one post (price in minor units); `get_paid_post` reads it once unlocked.
5. `rate_listing` gives 1 to 5 stars to someone else's listing, only with the number of stars the person chose.
6. ONDC (India's open network): `get_ondc_store` and `set_ondc_store` (ADR 0015).

## Rules

1. Never publish, price or change a listing without the person's yes for the exact details.
2. Never ask for bank details, card numbers or keys. Stripe collects them on its own page.
3. Listings must be real and lawful; never invent stock, reviews or urgency.
