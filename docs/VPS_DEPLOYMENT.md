# Lolah read-only deployment

## Current production architecture

Live inspection on 2026-08-11 confirmed a split standalone deployment. The consolidated `lolah` Render service runs the read-only X and Upbit scanners with its own persistent disk. The separate VPS runs Lolah ASP #10775's OKX A2A listener as Linux user `lolah`. PolyDesk remains an external context provider and must not share either process's identity or state.

Render never chooses recipients or receives OKX signing material. It exposes only a private, bearer-protected feed of fresh non-executable signals. The VPS polls that canonical HTTPS feed, intersects it with the official active-subscription set for Lolah Market Watch, and sends explicitly as #10775 through OKX's recipient-eligibility checked transport.

Do not copy Lolah into the PolyDesk repository or reuse PolyDesk's Linux user, wallet, agent ID, state, environment, logs, or service unit.

Lolah may share the physical host used by PolyDesk, but it must remain operationally separate. Do not reuse PolyDesk's Linux user, checkout, state, environment, logs, port, or systemd unit, and do not restart PolyDesk during installation.

## Boundaries

- Linux user and group: `lolah`
- application: `/opt/lolah/app`
- OKX listener state: `/var/lib/lolah-a2a`
- private dispatcher environment: `/etc/lolah/subscription-dispatcher.env`
- daemons: `lolah-a2a.service` and `lolah-subscription-dispatcher.service`

The deployed worker consumes CoinListing's raw Upbit feed at `wss://seoul.coinlisting.pro/feed`. Lolah keeps its own listing parser, accepts only official Upbit notice URLs, measures provider-to-Lolah latency at receipt, and durably suppresses exact replays. The provider key is configured only as the masked `LOLAH_COINLISTING_KEY` deployment secret and is never logged or persisted. Direct polling of Upbit's consumer website is not enabled in deployed mode. The worker persists fresh or stale revision decisions and simulation-only pull records. It cannot push messages, sign, trade, broadcast, bill, or register an OKX service.

Live listing enrichment is a separate durable loop in the same Lolah process and state file. Keep `LOLAH_UPBIT_ENRICHMENT_ENABLED=false` until the exact production PolyDesk context route is reviewed and returns the documented schema. When enabled, each fresh symbol receives a leased context job; recipient pulls wait for completion, retries do not block CoinListing ingestion, and five failed attempts finalize only a sanitized context-unavailable assessment.

## VPS preflight

Before copying files, verify the exact shared host, available disk and memory, Node 20 or newer, npm, and the status of PolyDesk without changing it. Abort if the target host cannot be proven to be the intended shared VPS.

## Legacy scanner-on-VPS installation (not active)

The following block is retained only for disaster recovery if the Render scanner is intentionally retired and its CoinListing IP slot and secrets are reconfigured directly by the operator. Do not run it alongside the current Render scanner.

Run as a privileged operator on the verified host:

```bash
id lolah >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/lolah --shell /usr/sbin/nologin lolah
install -d -o root -g root -m 0755 /opt/lolah /opt/lolah/app
install -d -o lolah -g lolah -m 0750 /var/lib/lolah
install -d -o root -g lolah -m 0750 /etc/lolah
install -o root -g lolah -m 0640 ops/upbit.env.example /etc/lolah/upbit.env
install -o root -g root -m 0644 ops/lolah-upbit.service /etc/systemd/system/lolah-upbit.service
cd /opt/lolah/app
npm ci
npm test
npm run typecheck
systemctl daemon-reload
systemctl enable --now lolah-upbit.service
```

Application files must be copied to `/opt/lolah/app` before `npm ci`. Do not copy `.env`, `.playwright-cli`, local state, credentials, or `node_modules`.

## Verification

```bash
systemctl is-active lolah-upbit.service
systemctl show lolah-upbit.service -p User -p Group -p MemoryCurrent -p NRestarts
journalctl -u lolah-upbit.service -n 50 --no-pager
test -s /var/lib/lolah/upbit-state.json
```

Expected behavior after first startup is a live poll with old notices suppressed as late. No prepared alert should be created merely because the worker bootstrapped against an old listing.

## Subscription dispatcher activation

Keep the dispatcher disabled until the same unlogged relay token has been entered directly in Render as `LOLAH_SUBSCRIPTION_FEED_TOKEN` and in `/etc/lolah/subscription-dispatcher.env` on the VPS. Never place its value in chat, shell history, source control, or service logs.

Install the reviewed unit only after the Render release containing `/internal/v1/subscription-signals` is healthy:

```bash
install -o root -g lolah -m 0640 ops/subscription-dispatcher.env.example /etc/lolah/subscription-dispatcher.env
install -o root -g root -m 0644 ops/lolah-subscription-dispatcher.service /etc/systemd/system/lolah-subscription-dispatcher.service
systemctl daemon-reload
systemctl enable --now lolah-subscription-dispatcher.service
systemctl is-active lolah-a2a.service lolah-subscription-dispatcher.service
journalctl -u lolah-subscription-dispatcher.service -n 50 --no-pager
```

Replace the example token before starting the unit. A healthy dispatcher reports `executionAllowed:false`, uses `/var/lib/lolah-a2a/subscription-push-ledger.json` for deduplication, and never accepts a recipient ID from the feed. Public buyer-controlled alert routes remain disabled.
