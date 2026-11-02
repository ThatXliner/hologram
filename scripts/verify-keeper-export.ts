import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const output = join(tmpdir(), "hologram-keeper-export");
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const executablePath = [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const thumbnail = (await readFile(new URL("./fixtures/stock/portrait.jpg", import.meta.url))).toString("base64");
    await page.addInitScript((thumbnail) => {
        const photo = { file_size: 100, exif: {}, created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z", thumbnail };
        const photos = [
            { ...photo, id: "photo-1", file_path: "/photos/keeper.NEF", file_name: "keeper.NEF", file_type: "NEF", flag: "pick", paired_with: "photo-2" },
            { ...photo, id: "photo-2", file_path: "/photos/keeper.JPG", file_name: "keeper.JPG", file_type: "JPEG", flag: "pick", paired_with: "photo-1" },
            { ...photo, id: "photo-3", file_path: "/photos/manual.JPG", file_name: "manual.JPG", file_type: "JPEG", flag: "pick" },
            { ...photo, id: "photo-4", file_path: "/photos/reject.JPG", file_name: "reject.JPG", file_type: "JPEG", flag: "reject" },
        ];
        const stats = { total_photos: 4, raw_count: 1, jpeg_count: 3, paired_count: 1, total_size: 400, cameras: {}, lenses: {} };
        Object.assign(window, {
            __TAURI_INTERNALS__: {
                invoke: async (command: string, args: { photos?: unknown }) => {
                    if (command === "scan_folder_fast") return { photos, stats };
                    if (command === "get_photo_stats") return stats;
                    if (command === "filter_photos") return args.photos;
                    if (command === "get_photo_metadata") return {};
                    if (command === "plugin:event|listen") return 1;
                    return null;
                },
                transformCallback: () => 1,
                unregisterCallback: () => {},
                convertFileSrc: (path: string) => path,
            },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        });
    }, thumbnail);
    await page.addInitScript(() => {
        const state = {
            exports: [] as { photos: { id: string; flag: string }[]; options: { destination_path: string; pair_mode: string; mode: string; organize_by: string } }[],
            dialog: "/mock/photos" as string | null,
            fail: false,
            opened: "",
        };
        const host = window as unknown as {
            __exportTest: typeof state;
            __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__: boolean;
            __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
        };
        host.__exportTest = state;
        host.__HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__ = true;
        const invoke = host.__TAURI_INTERNALS__.invoke;
        host.__TAURI_INTERNALS__.invoke = async (command, args) => {
            if (command === "plugin:dialog|open") return state.dialog;
            if (command === "find_missing_photo_ids") return [];
            if (command === "read_autocull_feature_cache") return [];
            if (command === "export_photos") {
                const request = args as unknown as typeof state.exports[number];
                state.exports.push(request);
                if (state.fail) throw new Error("Destination unavailable");
                return { exported_count: 3, skipped_count: 0, output_path: request.options.destination_path, metadata_path: null };
            }
            if (command === "plugin:opener|open_path") {
                state.opened = String(args.path);
                return null;
            }
            return invoke(command, args);
        };
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Import Photos", exact: true }).click();
    await page.locator("[data-photo-card]").first().waitFor();
    await page.getByRole("button", { name: "AutoCull", exact: true }).click();
    const exportKeepers = page.locator("header [data-autocull-export]");
    await exportKeepers.waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("header [data-autocull-export]")?.disabled);
    assert.match(await exportKeepers.innerText(), /2/);
    const reviewNode = await page.locator("[data-autocull-view]").elementHandle();
    await exportKeepers.click();
    const destination = page.getByLabel("Destination folder", { exact: true });
    assert.equal(await destination.inputValue(), "/mock/photos/culled");
    await page.getByRole("button", { name: "Both (RAW + JPEG)", exact: true }).waitFor();
    assert.match(await page.locator("body").innerText(), /Export AutoCull keepers · 2 kept photos/);
    await page.screenshot({ path: join(output, "keeper-export.png") });
    await page.setViewportSize({ width: 800, height: 600 });
    const copyBounds = await page.getByRole("button", { name: "Copy to culled", exact: true }).boundingBox();
    assert.ok(copyBounds && copyBounds.y + copyBounds.height < 600);
    await page.screenshot({ path: join(output, "keeper-export-compact.png") });
    await page.setViewportSize({ width: 1440, height: 900 });

    const flags = () => page.evaluate(async () => {
        const path = "/src/lib/stores/photoStore.ts";
        const { photoStore } = await import(path) as typeof import("../src/lib/stores/photoStore.ts");
        return photoStore.photos.map(({ id, flag }) => ({ id, flag }));
    });
    const before = await flags();
    await page.keyboard.press("p");
    await page.keyboard.press("Control+z");
    assert.deepEqual(await flags(), before);
    await page.evaluate(() => { (window as any).__exportTest.dialog = null; });
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    assert.equal(await destination.inputValue(), "/mock/photos/culled");
    await page.evaluate(() => { (window as any).__exportTest.fail = true; });
    await page.getByRole("button", { name: "Copy to culled", exact: true }).click();
    await page.getByText("Export failed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.evaluate(() => { (window as any).__exportTest.fail = false; });
    await page.getByRole("button", { name: "Copy to culled", exact: true }).click();
    await page.getByText("3 exported", { exact: true }).waitFor();
    const requests = await page.evaluate(() => (window as any).__exportTest.exports);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].photos.map((photo: { id: string }) => photo.id).sort(), ["photo-2", "photo-3"]);
    assert.ok(requests[1].photos.every((photo: { flag: string }) => photo.flag === "pick"));
    assert.ok(requests[1].allPhotos.every((photo: { flag: string }) => photo.flag !== "reject"));
    assert.equal(requests[1].options.destination_path, "/mock/photos/culled");
    assert.equal(requests[1].options.pair_mode, "both");
    assert.equal(requests[1].options.mode, "folder");
    assert.equal(requests[1].options.organize_by, "flat");
    await page.getByRole("button", { name: "Open folder", exact: true }).click();
    await page.waitForFunction(() => (window as any).__exportTest.opened === "/mock/photos/culled");
    await page.getByRole("button", { name: "Back to AutoCull", exact: true }).click();
    assert.equal(await reviewNode?.evaluate((node) => node.isConnected), true);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    assert.match(await page.locator("body").innerText(), /Exporting visible library · 3 photos/);
    assert.equal(await destination.inputValue(), "");
    await page.getByRole("button", { name: "Export 3", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).__exportTest.exports.length), 2);
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.evaluate(async () => {
        const path = "/src/lib/stores/photoStore.ts";
        const { photoStore } = await import(path) as typeof import("../src/lib/stores/photoStore.ts");
        for (const photo of photoStore.photos) photoStore.setPhotoFlag(photo.id, "none");
    });
    await page.getByRole("button", { name: "AutoCull", exact: true }).click();
    await page.locator("header [data-autocull-export]").waitFor();
    assert.equal(await page.locator("header [data-autocull-export]").isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(`Keeper export browser verification passed. Screenshots: ${output}`);
} finally {
    await browser.close();
    await server.close();
}
