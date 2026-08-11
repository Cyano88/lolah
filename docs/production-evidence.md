# Lolah production evidence

Evidence snapshot: 2026-08-11. This document separates live observations from source-enforced behavior
and unfinished work so judges can reproduce the supported claims without receiving credentials.

## Live production event

Lolah processed this genuine Upbit announcement:

- Event: `[거래] 댑오에스(DOS) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)`
- Official source: <https://www.upbit.com/service_center/notice?id=1478681589>
- Parsed listing: DOS in KRW, BTC, and USDT markets
- Measured provider-to-Lolah detection latency: 315 ms
- Hyperliquid result: no matching DOS perpetual market
- Safety result: no trade placed
- Delivery: completed through OKX A2A to an active Lolah Market Watch subscriber
- Buyer acknowledgement: the alert was recorded as intelligence only and no trade would be executed
  because there was no matching Hyperliquid perpetual.

This is important evidence of both speed and judgment. The successful outcome was not a forced long or
short; it was an explicit refusal to invent an executable market.

## Subscription delivery audit

The production recipient audit intersected OKX's active subscription views with Lolah's exact provider
and service identity.

- Provider: standalone Lolah ASP `#10775`
- Service: Lolah Market Watch
- Immutable service ID: `17abe635-66b5-45c7-bfa2-8c7b546474e1`
- Plan: 72-hour free trial, then 1 USDT per month
- Eligible subscriptions returned: 3
- Trial subscriptions among them: 2
- Production dispatcher: active with zero recorded restarts at the audit point
- Delivery result: OKX command completed and returned an outbound message ID
- Recipient acknowledgement: received through the agent conversation

No recipient is accepted from a public request. The VPS dispatcher derives recipients from the official
active-subscription set for Lolah, and every send still passes through OKX's recipient-eligibility path.
Local state is used only for delivery deduplication; it cannot extend billing eligibility.

## Deployed architecture observed

```text
CoinListing Seoul / curated X sources
                 |
                 v
       Lolah verification and freshness gates
                 |
                 v
    PolyDesk context + Hyperliquid availability
                 |
                 v
  private token-protected, non-executable signal feed
                 |
                 v
  isolated Lolah VPS subscription dispatcher
                 |
                 v
 official OKX active-subscription intersection
                 |
                 v
        eligible subscribed agents

signal and delivery commitments --> X Layer proof registry (deployment pending)
```

The Render scanner and VPS dispatcher are separate trust zones. Render never chooses recipients or
receives OKX signing material. The dispatcher does not receive a trading key and cannot turn an alert
into an order.

## Source-enforced safety evidence

- `LOLAH_MARKET_WATCH_PLAN` pins the exact service ID, 72-hour trial, and 1 USDT monthly price.
- Every subscription signal carries `executionAllowed: false`.
- Delivery is deduplicated across restarts and expired signals are suppressed.
- Provider and service matching fail closed on malformed or unrelated subscription responses.
- Upbit events require an official notice URL and retain source and receipt timing.
- PolyDesk and Hyperliquid failures produce bounded unavailable or no-trade outcomes.
- The X Layer proof builder hashes source URLs and message content instead of publishing them.
- The proof registry rejects duplicate batches and delivery roots without an existing signal root.

## Repository verification

Verified at release `1d453cef33d305c9cfec226d298a69d689c2e42a`:

```powershell
npm test
npm run typecheck
npm run contract:compile
```

The deployed eligibility fix at this release matches the immutable service ID first and falls back only
to the exact known service title. The recorded test run passed 157 tests and TypeScript type-checking.

## Evidence still required before submission

- Deploy `LolahSignalProofRegistry.sol` independently on X Layer.
- Anchor a sanitized signal batch containing the DOS proof commitment.
- Anchor its delivery batch and save both explorer links.
- Verify the dedicated Lolah X account and publish the tagged demo post.
- Capture a short screen recording showing the source notice, Lolah alert, safe no-trade result,
  subscriber receipt, and X Layer explorer proof.

Do not place API keys, bearer tokens, wallet material, private relay URLs, raw subscriber records, or
reusable authorization data in the submission package.
