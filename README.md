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

Live enrichment is gated by LOLAH_UPBIT_ENRICHMENT_ENABLED and defaults to false. It must remain disabled while the canonical PolyDesk production context route is unavailable. When enabled, LOLAH_POLYDESK_CONTEXT_ENDPOINT must be the exact HTTPS production route and LOLAH_POLYDESK_CONTEXT_TOKEN must contain the dedicated context-only bearer secret; loopback staging and alternate hosts are rejected by the deployed worker.

The continuous worker requires an explicit durable state path:

    LOLAH_UPBIT_STATE_PATH=/var/lib/lolah/upbit-state.json npm run upbit:worker

The worker is approved for an isolated supervised deployment under the read-only milestone. The current target is a separate Render background worker in PolyDesk's project and region, defined by `render.yaml`; it is not installed inside PolyDesk's web instance. See `docs/VPS_DEPLOYMENT.md`. Public alert routes remain disabled until official OKX session verification is configured.

The source registry is deliberately injected rather than populated with guessed accounts. Exact post receipts and validated semantic event clusters are durable across restarts. Production delivery remains disabled.

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

PolyDesk Prediction Market Context is planned as a pull subscription with a three-day free trial followed by 1 USDT per 30 days. Lolah Instant Scan is pull-based. Lolah Market Watch will be a separate opt-in push subscription after delivery, expiry, deduplication, wrong-recipient, and offline-replay tests pass.

No OKX service is listed from this workspace. The Upbit public-data monitor may be deployed as an isolated read-only daemon; trading, push delivery, billing, and public authenticated routes remain disabled.
