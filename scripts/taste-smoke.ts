/** Browser check for the opt-in AutoCull taste model: settings toggle, reject cutoff and ranking.
 * Run a dev server, then: HOLOGRAM_UI_URL=http://127.0.0.1:1420 bun scripts/taste-smoke.ts
 * Downloads the CLIP image model on first run (~340 MB, cached by the browser profile).
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { installTauriMock, resolveChromiumExecutable } from "./screenshots.ts";

const url = process.env.HOLOGRAM_UI_URL ?? "http://127.0.0.1:1420";
const output = join(tmpdir(), "hologram-taste-smoke");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
if (process.env.HOLOGRAM_SMOKE_VERBOSE) page.on("console", (message) => console.log(`[${message.type()}] ${message.text()}`));

try {
  await installTauriMock(page);
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).__photoStore__));
  await page.getByRole("button", { name: "Open photo folder", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-photo-card]").length > 0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "AutoCull taste model" });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  const slider = page.locator("[data-taste-settings] input[type=range]");
  await slider.fill("20");
  assert.match(await page.locator("[data-taste-settings]").innerText(), /lowest 20%/);
  const saved = await page.evaluate(() => localStorage.getItem("hologram.autocull.tasteModel.v1"));
  assert.deepEqual(JSON.parse(saved ?? "null"), { enabled: true, rejectPercent: 20 });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "01-settings.png") });
  console.log("PASS: taste model toggle and reject cutoff persist");

  await page.getByRole("button", { name: "AutoCull", exact: true }).click();
  await page.waitForSelector("[data-autocull-active-learner=taste]", { state: "attached", timeout: 600_000 });
  assert.equal(await toggle.count(), 0);
  await page.getByText(/lowest 20% of this shoot/).waitFor();
  await page.screenshot({ path: join(output, "02-autocull.png") });
  console.log("PASS: AutoCull ranks with the taste model");
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
