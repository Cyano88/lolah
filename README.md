# Lolah

Lolah is a standalone event-aware perpetual-market agent.

The current read-only vertical slice:

1. Reads recent posts through an injected X API bearer token.
2. Accepts only immutable author IDs in an explicit curated source registry.
3. Classifies supported event types and permitted entities deterministically.
4. Rejects stale posts, malformed source links, denials, ambiguous claims, impersonators, and exact duplicates.
5. Requires two distinct curated sources for corroboration unless the source is official.
6. Requests prediction-market context from PolyDesk.
7. Reads mapped Hyperliquid market metadata and order books.
8. Returns context_ready, watch, or no_trade.

It does not generate a direction, size, order, trade command, notification, wallet action, or marketplace listing.

## Upbit first-signal monitor

The deployed Upbit path consumes CoinListing's raw Seoul WebSocket feed and accepts only records linked to an official Upbit notice. It independently validates the listing title, symbols, quote markets, notice identity, provider timing, and receipt timing. A revision observed within the configured 15-second window may create a simulation-only early-listing draft; older observations are recorded but suppressed as stale alpha. Notice edits supersede earlier prepared drafts.

Upbit monitor state, drafts, wildcard or symbol-scoped watches, and recipient-bound delivery leases are persisted atomically in a separate state file. Authenticated routes expose `/v1/upbit/watches`, `/v1/upbit/alerts/pull`, and owner-only acknowledgement/cancellation variants. Access tokens and raw idempotency keys are never persisted. A matching fresh event can be pulled only by the same authenticated agent and session; delivery and execution remain disabled.

Fresh listing drafts also create one durable context-enrichment job per symbol. The enrichment worker reads current PolyDesk and Hyperliquid context independently of the CoinListing socket, uses leased retries with bounded backoff, and finalizes a sanitized context-unavailable assessment after five failures. Recipient pulls remain pending until every symbol has either a completed assessment or that safe terminal fallback. Provider failures never discard the base listing event or block WebSocket ingestion.

Live enrichment is gated by LOLAH_UPBIT_ENRICHMENT_ENABLED and defaults to false. It must remain disabled while the canonical PolyDesk production context route is unavailable. When enabled, LOLAH_POLYDESK_CONTEXT_ENDPOINT must be the exact HTTPS production route and LOLAH_POLYDESK_CONTEXT_TOKEN must contain the dedicated context-only bearer secret; loopback staging and alternate hosts are rejected by the deployed worker. CoinListing ingestion continues durably during a PolyDesk outage, while enrichment waits behind an authenticated provider-free health preflight.

The continuous worker requires an explicit durable state path:

    LOLAH_UPBIT_STATE_PATH=/var/lib/lolah/upbit-state.json npm run upbit:worker

The worker is approved for an isolated supervised deployment under the read-only milestone. The current target is a separate Render background worker in PolyDesk's project and region, defined by `render.yaml`; it is not installed inside PolyDesk's web instance. See `docs/VPS_DEPLOYMENT.md`. Public alert routes remain disabled until official OKX session verification is configured.

The source registry is deliberately injected rather than populated with guessed accounts. Exact post receipts and validated semantic event clusters are durable across restarts. Production delivery remains disabled.

## X intelligence worker

The isolated `lolah-x-intelligence` worker has two coverage lanes. Official exchanges, foundations, projects, founders, developers, and regulators are read as a full original-post firehose, so detection does not depend on an announcement using a predicted keyword. Curated crypto-news, research, and security sources are searched through bounded catalyst groups covering listings, exploits, shutdowns, launches, unlocks, airdrops, acquisitions, regulation, outages, upgrades, governance, leadership, depegs, burns, and buybacks.

Every source must include its current numeric X author ID, username, trust tier, role category, permitted entities, and mapped Hyperliquid markets. Returned posts are accepted by author ID rather than handle alone. Unknown accounts and impersonators cannot produce a verified event; non-official reporting requires two distinct curated sources. Compound announcements retain the highest-priority supported catalyst instead of being silently discarded.

FanVibe's official `@FanVibeOnX` account is a first-party FVB watch source. Buyback announcements map to the FVB entity and deliberately check the `FVB` venue symbol; because FVB is not listed on Hyperliquid, the normal venue lookup must return `not_found` and the resulting alert remains `no_trade`. Official-project alerts explicitly disclose that they are first-party project or issuer announcements rather than independent analysis.

Strictly additive catalog expansion is the only pin exception: X must resolve every new handle to an immutable author ID, and every previously pinned entity and source must remain byte-for-byte equivalent. Any edit or removal still fails closed.

Queries are sharded below X's self-serve query-length limit. Official-account queries run no more often than every five minutes; broader catalyst queries run no more often than every thirty minutes, with intervals expanding automatically as the registry grows. A source with no checkpoint starts from a bounded two-minute window instead of purchasing a seven-day historical backlog. Production searches resolve authors from the pinned registry instead of purchasing repeated X User Reads. A durable `LOLAH_X_DAILY_POST_CAP` circuit breaker defaults to 50 unique posts per UTC day and is additionally bounded by `LOLAH_X_DAILY_USD_CAP`, which defaults to $0.50 and cannot exceed $1.00. Request sizes shrink to the remaining allowance and reads stop below X's ten-result minimum until the next UTC day. Checkpoints advance only after complete pagination, and credentials and pagination cursors are never written to durable state.

The Render blueprint defines this as a second worker with its own disk and state path. It defaults to disabled. Enabling it requires `LOLAH_X_BEARER_TOKEN`, the dedicated PolyDesk context token, and `LOLAH_X_ENABLED=true`. On its first enabled start, the worker resolves the proof-backed catalog to immutable numeric X author IDs and pins the result on its dedicated disk. Later restarts use that pin and fail closed if the curated catalog changes. The worker preflights the authenticated PolyDesk read-only bridge before polling. It remains simulation-only and cannot push, sign, trade, bill, or list itself.

The checked-in starter catalog is `config/x-source-catalog.json`. Each handle has a non-X identity-proof URL, a trust tier, a source role, and either an explicit entity scope or the exclusive `*` scope meaning every curated entity. The catalog currently covers 24 verified Hyperliquid markets and nine proof-backed sources. Resolve handles to their current immutable numeric IDs through the official X batch lookup before activation:

    $env:LOLAH_X_BEARER_TOKEN = '<set locally>'
    npm run x:resolve-sources

For manual staging, the resolver can still produce registry JSON. Production resolves the checked-in catalog once and stores only public numeric author IDs in `LOLAH_X_SOURCE_PIN_PATH`; the bearer token is never persisted. Never commit the bearer token or paste it into chat. A failed, partial, renamed, or deleted X identity blocks registry generation rather than silently dropping that source. At worker startup, the registry is expanded from Hyperliquid's official read-only universe so wildcard sources cover every currently available perp. Automatically added markets use strict case-sensitive ticker matching; richer curated names and aliases always take precedence.

No finite source list can guarantee that every crypto event will be captured. Upbit therefore remains on its dedicated lower-latency website feed, while X provides broad complementary coverage. Filtered-stream support and continuous post-event price-reaction tracking are separate follow-up milestones.

## Combined public service staging

The service command starts one Node process containing the public HTTP listener plus independently supervised X and Upbit worker runtimes. Each enabled worker requires a distinct durable state file, and one provider or configuration failure cannot terminate the HTTP listener or the other worker. A disabled Upbit staging runtime may derive its unused state location beside the X state file for backward-compatible deploys; enabling Upbit still requires LOLAH_UPBIT_STATE_PATH explicitly. The staging deployment keeps both LOLAH_X_ENABLED=false and LOLAH_UPBIT_ENABLED=false, so it cannot duplicate production scans or spend X or CoinListing capacity. GET /health and the zero-parameter POST /v1/status are the only public routes. Status reports both worker states and the durable X post-read allowance while keeping secrets, post contents, alerts, watches, and recipient identities private.

The existing watch and simulated alert handlers remain loopback-only fixtures. They are not mounted by the public adapter because official OKX recipient-session verification is not yet configured. Unknown public paths, including watch and alert paths, return 404; sending, execution, billing, subscriptions, and listing remain disabled.

## Upbit historical shadow replay

The replay runner fetches genuine recent Upbit records from CoinListing's public, keyless history endpoint. Receipt timing is explicitly simulated from the provider's sent_time field and never represented as a live measurement. Each supported symbol is converted into the same verified Lolah event contract used by the normal context pipeline.

Hyperliquid replay pricing uses timestamped five-minute candles around the listing time. It compares the candle immediately before the event with the candle containing the event and reports the window explicitly. Historical order books are unavailable, so historical liquidity remains unknown rather than being reconstructed from today's book. PolyDesk matching runs through the isolated loopback staging route until its production service is reviewed and enabled.

The assessment is non-executing and can return positive_catalyst_watch, chasing_risk, weakness_watch, market_unavailable, risk_blocked, or context_unavailable. A ten-percent or larger event-window rise is classified as chasing risk. Every replay keeps simulationOnly true, sendAllowed false, and executionAllowed false.

Run the latest supported listing directly, or select a symbol still present in the provider's recent history:

    node --import tsx scripts/replay-latest-upbit-listing.ts
    LOLAH_REPLAY_SYMBOL=CFX node --import tsx scripts/replay-latest-upbit-listing.ts

## Durable watch-state gate

The local durable-state layer now persists explicit watch expiry, cancellation, post fingerprints, monotonic polling checkpoints, and recipient-bound delivery envelopes. It serializes same-process writers targeting the same state path, fails closed on corrupt state, rejects changed-content replays, and never stores X pagination tokens or API credentials.

Delivery envelopes are preparation records only and always contain `sendAllowed: false`. Upbit watch fan-out and authenticated simulation pull are implemented; outbound push delivery and marketplace subscription billing remain disabled.

The polling batch is explicit rather than scheduled. It applies a durable rate gate, resumes with `since_id`, drains transient X pagination within a bounded invocation, and refuses to advance the checkpoint if the page cap leaves the result window incomplete.

Context reads use a durable leased queue. Event persistence and job creation are atomic; temporary provider failures use bounded exponential backoff, expired leases can be reclaimed after a worker crash, and five failed attempts move a job to a sanitized dead-letter state. Queue draining remains explicitly invoked and read-only.

Completed verified context can create idempotent alert drafts for active matching watches. Drafts use canonical entity IDs and markets, remain isolated by recipient, classify blocked context explicitly, and always contain `sendAllowed: false`. Stronger event revisions supersede older prepared drafts. These are stored preparation records; no transport consumes them.

An injected verifier can authorize a short-lived `lolah` recipient/session principal for simulation-only pull delivery. Outbox leases bind to that exact subject and session, expired offline leases are reclaimable, and acknowledgements are simulated state transitions. Access tokens are transient and never persisted. No network transport is implemented.

Framework-neutral local route handlers expose fixture-only health, pull, and acknowledgement contracts. The OKX adapter consumes an injected session-introspection result and does not decode or trust JWT claims locally. Live OKX authentication remains intentionally unconfigured until an official token-verification or introspection contract is available.

Authenticated local routes also support idempotent watch creation, recipient-filtered listing, and owner-only cancellation. Idempotency keys are hashed before persistence. A separate fixture adapter models the documented task-message eligibility fields, including agent IDs, job/group IDs, direction, XMTP addresses, security rate, and offline replay; it is not incorrectly applied to ordinary watch requests.

Inbound OKX fixture envelopes are classified by shape precedence: system event, then agent chat, then standalone prefetch. Embedded content is always marked untrusted and never executed by this layer. A Node-compatible adapter rejects non-loopback clients, malformed JSON, and bodies over 64 KiB; it exports only a request handler and never creates or starts an HTTP server.

The deterministic end-to-end fixture runner accepts only a non-terminal agent chat that resolves Lolah to the ASP role. Chat text is never parsed into watch fields. A separate structured watch fixture must match the inbound job and the introspected recipient before the runner can create a watch, ingest an injected X response, execute an injected read-only context scan, and pull a simulation-only alert through the authenticated local route. System events, prefetch messages, terminal rejections, wrong roles, and identity mismatches stop before polling or state mutation. The runner never invokes the canonical live next-action or user-notification flows.

## Local verification

Run:

    npm test
    npm run typecheck
    npm run fixture:e2e

The fixture:e2e command uses only synthetic inbound, session, X, PolyDesk, and Hyperliquid data. It creates temporary durable state, prints a sanitized simulation result, and removes that temporary state before exiting.

The live shadow command performs public read-only checks without starting a server. It calls only the canonical PolyDesk context route, the official Hyperliquid info endpoint, and the official X recent-search endpoint when X_BEARER_TOKEN is configured. Each provider reports independently as ok, not_configured, or unavailable; raw provider errors and bearer tokens are never returned. A partial result is expected while the production PolyDesk route remains gated.

Local staging is a separate mode that accepts only the exact context path on an explicit http://127.0.0.1 port. It does not allow localhost aliases, external HTTP hosts, credentials, query strings, or the production origin. The PolyDesk staging process must be started separately and shut down after the shadow run.

With the PolyDesk staging process running on port 4317:

    npm run shadow:staging

The command requires both PolyDesk and Hyperliquid to succeed. X remains not_configured until X_BEARER_TOKEN is supplied through the process environment; the token is never returned or persisted.

The full live staging pipeline additionally requires LOLAH_SOURCE_REGISTRY_PATH, LOLAH_X_QUERY, LOLAH_WATCH_ENTITY_IDS, and LOLAH_WATCH_TARGET_MARKETS. It refuses missing credentials, unknown entities, and markets outside the curated registry before making a request. It uses temporary durable state and can stage only simulation outbox records.

## Commercial plan

PolyDesk Prediction Market Context is planned as a pull subscription. Lolah Instant Scan is pull-based. Lolah Market Watch is the opt-in push product: 72 hours free, then 1 USDT per month. Its dispatcher fails closed unless it can intersect OKX's current active-subscription jobs with subscriptions provided by Lolah's exact ASP identity; each message still passes through OKX's recipient-eligibility check. Delivery is deduplicated durably across restarts, expired signals are suppressed, and billing eligibility is never extended from local cached state.

Lolah Market Watch is listed under standalone Lolah ASP #10775, and a controlled direct OKX subscription delivery test has passed. The consolidated Render scanner remains read-only. Production push uses a private token-protected signal feed polled by Lolah's isolated VPS dispatcher; the dispatcher still intersects the live OKX active-subscription set and sends explicitly as #10775. Trading, signing, billing mutation, and public buyer-controlled alert routes remain disabled.

The private bridge requires the same unlogged `LOLAH_SUBSCRIPTION_FEED_TOKEN` on Render and in `/etc/lolah/subscription-dispatcher.env` on the VPS. The VPS unit template is `ops/lolah-subscription-dispatcher.service`; its ledger stays under `/var/lib/lolah-a2a` and never stores the relay token or subscriber billing state.

## X Layer proof and BuildX

Lolah's hackathon onchain component is a privacy-preserving signal proof registry. The offchain worker
builds deterministic Merkle commitments from verified signal batches; the contract anchors only batch
roots, counts, time windows, and release hashes on X Layer. Subscriber identities, alert text, positions,
and trading instructions are never written onchain. Compile it with npm run contract:compile.

The current eligibility and evidence checklist is in docs/buildx-submission.md, the sanitized live audit
is in docs/production-evidence.md, and the judge demo is in docs/demo-script.md. A real Upbit alert has
passed the production subscription-delivery path, and its signal and delivery commitments are anchored
in the deployed X Layer registry. Explorer source verification, verification of the dedicated Lolah X
account, and final submission remain pending.
