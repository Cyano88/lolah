# Lolah read-only deployment

## Current production target: Render

Live workspace inspection on 2026-08-10 confirmed that PolyDesk is a managed Render web service in the Oregon region, not a root-access VPS. Lolah must therefore use a separate Render background worker in the same project/region. It must not be installed inside, or added to the start command of, the PolyDesk web service.

`render.yaml` defines `lolah-upbit` with its own process and persistent disk. The worker exposes no public port and does not require OKX, wallet, X, PolyDesk, or trading credentials. The repository is public at `https://github.com/Cyano88/lolah`.

Do not copy Lolah into the PolyDesk repository merely to reuse its deployment connection.

The systemd instructions below are retained only for a future genuine root-access VPS. They do not apply to the current Render target.

Lolah may share the physical host used by PolyDesk, but it must remain operationally separate. Do not reuse PolyDesk's Linux user, checkout, state, environment, logs, port, or systemd unit, and do not restart PolyDesk during installation.

## Boundaries

- Linux user and group: `lolah`
- application: `/opt/lolah/app`
- durable state: `/var/lib/lolah/upbit-state.json`
- private environment: `/etc/lolah/upbit.env`
- daemon: `lolah-upbit.service`

The deployed worker consumes only an authorized relay of Upbit website notices. Every relay envelope must carry an Ed25519 signature, monotonic sequence, and official Upbit notice URL. Lolah stores only the provider public key, recomputes freshness at receipt, and rejects unsigned, replayed, conflicting, future, or stale envelopes. Direct polling of Upbit's consumer website is not enabled in deployed mode. The worker persists fresh or stale revision decisions and simulation-only pull records. It cannot push messages, sign, trade, broadcast, bill, or register an OKX service.

## Root-access VPS alternative: preflight

Before copying files, verify the exact shared host, available disk and memory, Node 20 or newer, npm, and the status of PolyDesk without changing it. Abort if the target host cannot be proven to be the intended shared VPS.

## Installation

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

Public HTTP routes are a later gate. Do not expose the local route handler until official OKX session verification is configured and tested against the real issuer and audience.
