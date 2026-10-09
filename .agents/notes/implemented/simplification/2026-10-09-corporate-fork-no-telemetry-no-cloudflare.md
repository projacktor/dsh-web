# Corporate fork: no outbound telemetry, no Cloudflare

**Status:** implemented (2026-10-09)
**Class:** simplification
**Scope:** `packages/*`, `shared/`, `scripts/`, repository infrastructure

## Decision

This repository is an internal corporate fork of dsh-web for closed-network
deployments. Two upstream properties are removed outright:

1. **Anonymous install telemetry.** The shared reporter
   (`shared/client/telemetry.ts`, synced copies in ten plugins) sent one daily
   heartbeat to `https://dsh-market.com/api/telemetry/event`; the Workshop card
   additionally posted likes and install events carrying a device fingerprint
   through a Turnstile-gated edge API. All of it is gone: no heartbeat, no
   like button, no install-event reporting, no Turnstile client, no
   `device_fp`.
2. **Cloudflare dependencies.** The `cloudflared` npm package (postinstall
   binary) powered dsh-remote-web-ui's quick/named auto-tunnels and the
   `<id>.dsh-market.com` relay registry; the `market/` directory (Cloudflare
   Worker, D1 migrations, telemetry-view dashboard, try-on site, deploy
   pipeline) hosted the Workshop site itself. All removed: `remote-web-ui`
   keeps LAN pairing plus the manual `publicBaseUrl` (reverse proxy), the
   Workshop card keeps user-initiated browsing/install, and the repository
   carries no site infrastructure.

## Rejected alternatives

- **Remove the `dsh-market` package entirely** — rejected: the preset-center
  satellite renders its panel into the `dsh-workshop.panel` slot the card
  declares, and the card bridges the official plugin manager. Removing the
  card would break satellite rendering for no closed-network gain.
- **Vendor patched satellite copies** (skin-center, pet, preset-center,
  community-plugins) — rejected for now: they are upstream-published npm
  packages; their own telemetry (per upstream docs, skin-center reports
  installed skins in the heartbeat) stays until those repositories get
  corporate forks. Documented limitation, not an oversight.
- **Keep `market/` but never deploy it** — rejected: the site is inert in the
  plugin runtime, but keeping a Cloudflare Worker + D1 + deploy workflow in a
  fork whose requirement is "no Cloudflare" invites accidental reintroduction.

## Constraints for future work

- Root `AGENTS.md` Repository Rules now carry a standing rule: do not
  reintroduce telemetry, Turnstile, `cloudflared`, or `market/` infrastructure.
- `publicBaseUrl` / `trustedHosts` / LAN bind in dsh-remote-web-ui are the
  supported public-access paths (corporate reverse proxy), not tunnels.
- dsh-update's registry/release probes (GET-only checks against
  registry.npmjs.org and api.github.com) are a feature, not telemetry; they
  stay.
- The e2e mount gate mounts fork builds only: `scripts/e2e-mount-rewrite`
  auto mode packs every workspace `@linxin666/*` dependency into a `file:`
  tarball and never mounts its npm twin — same-numbered registry releases are
  upstream code that still carries the removed surface (upstream
  `dsh-remote-web-ui@0.4.5` depends on `cloudflared`, so the registry path
  would both violate the standing rule and die in pnpm 11
  strict-dep-builds). Extracted satellites keep resolving from the registry
  until they get corporate forks; `tests/e2e/fork-isolation.e2e.ts` asserts
  the booted GUI sends no telemetry/like/install/Turnstile/Cloudflare
  traffic.
- Multi-word `DSH_CMD` (e.g. `pnpm --dir <install> dsh`) is supported by
  `scripts/e2e-mount.sh`; the server runs under `setsid` so cleanup can
  TERM/KILL the whole process group — a pnpm wrapper survives a plain
  SIGTERM and would leave the scratch server orphaned.
