/** Browser checks for the library workflow. Uses the existing local photo fixtures and Tauri mock.
 * Run a dev server, then: HOLOGRAM_UI_URL=http://127.0.0.1:1430 bun run check:ui
 * These checks exercise the frontend; native folder access and exports are mocked.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { installTauriMock, resolveChromiumExecutable, seedPhotos } from "./screenshots.ts";

const url = process.env.HOLOGRAM_UI_URL ?? "http://127.0.0.1:1420";
const output = join(tmpdir(), "hologram-ui-smoke");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors: string[] = [];
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(5000);

async function photoCount(count: number, target = page) {
    await target.waitForFunction((expected) => document.querySelectorAll("[data-photo-card]").length === expected, count, { timeout: 4000 });
    assert.equal(await target.locator("[data-photo-card]").count(), count);
}
async function clearFilters() {
    const clear = page.getByRole("button", { name: "Clear all", exact: true });
    if (await clear.isVisible()) await clear.click();
}
async function capture(name: string, target = page) {
    await target.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>("img.photo-preview-image")).every((image) => image.complete && image.naturalWidth > 0));
    await target.evaluate(async () => {
        await Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>("img.photo-preview-image"), (image) => image.decode()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await target.screenshot({ path: join(output, `${name}.png`) });
}
async function photosState() {
    return page.evaluate(() => (window as any).__photoStore__.photos.map((photo: any) => ({ id: photo.id, flag: photo.flag, rating: photo.rating })));
}

try {
    await installTauriMock(page);
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as any).__photoStore__));
    assert.equal(await page.getByRole("button", { name: "AutoCull", exact: true }).isDisabled(), true);
    await capture("01-welcome");
    await page.getByRole("button", { name: "Open photo folder", exact: true }).click();
    await photoCount(12);
    assert.match(await page.locator("main header").innerText(), /12 of 12 photos/);
    assert.match(await page.locator("#library-filters").innerText(), /12 photos · 14 files/);
    assert.equal(await page.getByLabel("Minimum rating").inputValue(), "0");
    assert.equal(await page.locator("#filter-camera_model").inputValue(), "");
    await capture("02-library");
    console.log("PASS: folder entry, one photograph per RAW+JPEG pair, visible defaults");

    await page.getByRole("heading", { name: "photos", exact: true }).click();
    await page.keyboard.press("/");
    assert.equal(await page.getByRole("textbox", { name: "Search photos" }).evaluate((element) => element === document.activeElement), true);
    await page.getByRole("textbox", { name: "Search photos" }).fill("nothing-matches-this");
    await photoCount(0);
    await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
    await photoCount(12);
    await page.getByLabel("Camera Model", { exact: true }).selectOption("EOS R5");
    await photoCount(4);
    await page.getByLabel("Minimum rating").selectOption("3");
    await photoCount(1);
    await page.getByRole("textbox", { name: "Search photos" }).fill("another-empty-result");
    await photoCount(0);
    await capture("03-no-results");
    await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
    await photoCount(12);
    assert.equal(await page.getByLabel("Minimum rating").inputValue(), "0");
    assert.equal(await page.locator("#filter-camera_model").inputValue(), "");
    console.log("PASS: search shortcut, combined filters, empty-result recovery and control reset");

    await page.getByRole("button", { name: "Picks 2", exact: true }).click();
    await photoCount(2);
    await page.getByRole("button", { name: "Save search", exact: true }).click();
    await page.getByLabel("Search name").fill("Wedding picks");
    await page.getByRole("dialog", { name: "Save this search" }).getByRole("button", { name: "Save search", exact: true }).click();
    await clearFilters();
    await photoCount(12);
    await page.getByRole("button", { name: "Wedding picks", exact: true }).click();
    await photoCount(2);
    await capture("04-saved-search");
    console.log("PASS: named searches save and restore filters");

    await page.getByRole("button", { name: "Reject X", exact: true }).click();
    await photoCount(1);
    const paired = (await photosState()).filter((photo: any) => ["photo-1", "photo-2"].includes(photo.id));
    assert.ok(paired.every((photo: any) => photo.flag === "reject"));
    assert.match(await page.locator("main header").innerText(), /1 of 12 photos/);
    console.log("PASS: changing a pick updates the active filter and both paired files");

    await clearFilters();
    await page.getByRole("button", { name: /Unmarked \d+/ }).click();
    const nextUnmarked = await page.locator("[data-photo-card]").nth(1).getAttribute("aria-label");
    await page.keyboard.press("p");
    await photoCount(8);
    assert.equal(await page.locator('[data-photo-card][aria-current="true"]').getAttribute("aria-label"), nextUnmarked);
    console.log("PASS: keyboard culling advances to the next remaining photo");

    await clearFilters();
    await page.getByRole("button", { name: "IMG_7310.CR3", exact: true }).click();
    await page.getByRole("button", { name: "Review photo", exact: true }).click();
    await page.getByRole("button", { name: "Close viewer" }).waitFor();
    const beforeViewer = await photosState();
    await page.keyboard.press("x");
    await page.waitForTimeout(100);
    const afterViewer = await photosState();
    const changed = afterViewer.filter((photo: any, i: number) => photo.flag !== beforeViewer[i].flag);
    assert.deepEqual(changed.map((photo: any) => photo.id), ["photo-10"]);
    await capture("05-review");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Review photo", exact: true }).waitFor();
    await page.locator('[data-photo-card][aria-current="true"]').focus();
    await page.keyboard.press("ArrowLeft");
    const focusedPhoto = await page.locator('[data-photo-card][aria-current="true"]').getAttribute("aria-label");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Close viewer" }).waitFor();
    assert.match(await page.getByRole("button", { name: "Close viewer" }).locator("..").innerText(), new RegExp(focusedPhoto!));
    await page.getByRole("button", { name: "Close viewer" }).click();
    const activeCard = page.locator('[data-photo-card][aria-current="true"]');
    await activeCard.getByRole("button", { name: "3 stars", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "Close viewer" }).isVisible(), false);
    assert.equal(await activeCard.getByRole("button", { name: "3 stars", exact: true }).evaluate((element) => element === document.activeElement), true);
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    const beforeHelp = await photosState();
    await page.keyboard.press("p");
    assert.deepEqual(await photosState(), beforeHelp);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible(), false);
    console.log("PASS: viewer shortcuts affect only the active photo; dialogs isolate keyboard input");

    await page.getByRole("button", { name: /Picks \d+/ }).click();
    const countToExport = await page.locator("[data-photo-card]").count();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    assert.match(await page.locator("body").innerText(), new RegExp(`Exporting the filtered library · ${countToExport} photos`));
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await photoCount(countToExport);
    console.log("PASS: export explains its scope and returns to the same filtered library");

    const compact = await context.newPage();
    compact.on("pageerror", (error) => errors.push(error.message));
    await compact.setViewportSize({ width: 800, height: 600 });
    await installTauriMock(compact);
    await compact.goto(url);
    await compact.waitForFunction(() => Boolean((window as any).__photoStore__));
    await seedPhotos(compact);
    await photoCount(12, compact);
    assert.equal(await compact.locator("#library-filters").isVisible(), false);
    assert.equal(await compact.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const name of ["Filters", "Review photo", "Grid", "Timeline"]) {
        const box = await compact.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 800, `${name} should fit at 800px`);
    }
    await capture("06-compact-library", compact);
    await compact.getByRole("button", { name: "Filters", exact: true }).click();
    await compact.getByLabel("Camera Model", { exact: true }).selectOption("A7R V");
    await compact.getByRole("button", { name: "Close library filters", exact: true }).click();
    await photoCount(3, compact);
    await compact.getByText("View options", { exact: true }).click();
    await compact.getByLabel("Photo details", { exact: true }).selectOption("essentials");
    await capture("07-compact-view-options", compact);
    await compact.keyboard.press("Escape");
    assert.equal(await compact.getByLabel("Photo details", { exact: true }).isVisible(), false);
    await compact.getByText("View options", { exact: true }).click();
    await compact.getByRole("heading", { name: "Photo library", exact: true }).click();
    assert.equal(await compact.getByLabel("Photo details", { exact: true }).isVisible(), false);
    await compact.getByRole("button", { name: "Timeline", exact: true }).click();
    await compact.locator("button.photo-tile").first().focus();
    await compact.keyboard.press("Space");
    await compact.getByRole("button", { name: "Close viewer" }).waitFor();
    await compact.getByRole("button", { name: "Close viewer" }).click();
    await compact.close();
    console.log("PASS: controls, filters and view settings work at the native 800×600 window size");

    await clearFilters();
    await page.evaluate(() => {
        const internals = (window as any).__TAURI_INTERNALS__;
        const invoke = internals.invoke;
        internals.invoke = async (cmd: string, args: unknown) => {
            if (cmd === "scan_folder_fast") throw new Error("Test: unavailable folder");
            return invoke(cmd, args);
        };
    });
    await page.getByRole("button", { name: "Open another folder", exact: true }).click();
    await page.getByRole("alert").waitFor();
    await photoCount(12);
    console.log("PASS: folder errors are visible and preserve the loaded library");

    await page.evaluate(() => {
        const internals = (window as any).__TAURI_INTERNALS__;
        const invoke = internals.invoke;
        internals.invoke = async (cmd: string, args: unknown) => {
            if (cmd === "scan_folder_fast") {
                await new Promise((resolve) => setTimeout(resolve, 400));
                return { photos: [], stats: { total_photos: 0, raw_count: 0, jpeg_count: 0, paired_count: 0, total_size: 0, cameras: {}, lenses: {} } };
            }
            return invoke(cmd, args);
        };
    });
    await page.getByRole("button", { name: "Picks 2", exact: true }).click();
    await page.getByRole("button", { name: "Open another folder", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Opening photo folder" }).waitFor();
    await page.getByRole("heading", { name: "No photos in this folder", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Open photo folder", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Clear all", exact: true }).isVisible(), false);
    await capture("08-empty-folder");
    console.log("PASS: loading feedback, empty-folder recovery and new-folder filter reset");
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(`Screenshots: ${output}`);
} finally {
    await context.close();
    await browser.close();
}
