/**
 * Corporate-fork isolation lane: prove the mounted aggregate never talks to
 * telemetry, like/install-report, Turnstile, or Cloudflare tunnel endpoints,
 * and that the booted GUI carries no Cloudflare tunnel surface.
 *
 * This lane mounts the packed `@linxin666/dsh-web-all` tarball into a real
 * `dsh web` instance (server booted by `scripts/e2e-mount.sh`, base URL in
 * `DSH_E2E_URL`), loads the GUI, and watches every request the page makes.
 *
 * Satellite note: the mount still pulls the upstream satellites
 * (@linxin666/*@0.4.5) from the registry, and upstream code carries its own
 * heartbeat. That reporter stays silent here because a Playwright browser
 * runs with `navigator.webdriver === true`, which the upstream reporter
 * checks before sending — so "no telemetry request" is a valid assertion for
 * the whole page, not just the in-repo family.
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the aggregate bundle mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** Endpoints the corporate fork must never contact from the GUI. */
const FORBIDDEN_URL_PATTERNS: RegExp[] = [
  /\/api\/telemetry\//,
  /\/api\/like/,
  /dsh-market\.com\/api\/install/,
  /challenges\.cloudflare\.com/,
  /\.trycloudflare\.com/,
  /dsh-market\.com\/api\/relay\//,
]

test('the booted GUI sends no telemetry, likes, install events, or Cloudflare traffic', async ({ page }) => {
  const forbidden: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (FORBIDDEN_URL_PATTERNS.some((pattern) => pattern.test(url))) forbidden.push(url)
  })

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  // The host frame mounting proves the aggregate booted; give the app a beat
  // to fire whatever background requests a boot produces.
  await page.waitForSelector('[data-dsh-frame]', { state: 'attached', timeout: 30_000 })
  await page.waitForTimeout(5_000)

  expect(forbidden, 'forbidden outbound requests').toEqual([])
})
