<script lang="ts">
    import { CalendarDays, Check, FileImage, Info, XCircle } from "@lucide/svelte";
    import { tick } from "svelte";
    import { photoStore, selectedIndex, viewMode } from "../stores/photoStore.ts";
    import { cullKeyAction, keepsNativeActivation, shouldIgnoreShortcut } from "../shortcuts.ts";
    import type { Photo } from "../types.ts";
    import PhotoPreview from "./PhotoPreview.svelte";

    interface Props {
        photos: Photo[];
        tileMinWidth?: number;
    }

    let { photos, tileMinWidth = 220 }: Props = $props();

    type EmbeddedPreview = NonNullable<Photo["embedded_jpeg_preview"]>;

    const timelineTileMinWidth = $derived(Math.max(112, Math.min(240, Math.round(tileMinWidth * 0.55))));

    const groupedPhotos = $derived(groupByDay(photos));
    // Days are shown newest first, so keyboard order follows the screen, not the library.
    const visualOrder = $derived(groupedPhotos.flatMap((group) => group.items));
    let rootEl = $state<HTMLDivElement>();

    function groupByDay(items: Photo[]) {
        const groups = new Map<string, Photo[]>();
        for (const photo of items) {
            const date = photo.exif.date_taken ?? photo.modified_at ?? photo.created_at;
            const key = new Date(date).toISOString().slice(0, 10);
            groups.set(key, [...(groups.get(key) ?? []), photo]);
        }
        return Array.from(groups.entries())
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([key, items]) => ({
                key,
                label: formatDay(key),
                items,
            }));
    }

    function formatDay(key: string): string {
        return new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
        }).format(new Date(`${key}T12:00:00`));
    }

    function embeddedPreviewInfo(photo: Photo): EmbeddedPreview | null {
        return photo.embedded_jpeg_preview ?? photo.paired_raw_embedded_jpeg_preview ?? null;
    }

    function embeddedPreviewTitle(preview: EmbeddedPreview): string {
        const dimensions = preview.width && preview.height ? `${preview.width} x ${preview.height}` : "JPEG";
        return `RAW includes an embedded JPEG preview (${dimensions}). Consider shooting RAW only instead of RAW+JPEG.`;
    }

    function globalIndex(photo: Photo): number {
        return photos.findIndex((item) => item.id === photo.id);
    }

    function selectPhoto(photo: Photo) {
        const index = globalIndex(photo);
        if (index >= 0) photoStore.setSelectedIndex(index);
    }

    function openPhoto(photo: Photo) {
        const index = globalIndex(photo);
        if (index < 0) return;
        photoStore.setSelectedIndex(index);
        photoStore.setViewMode("viewer");
    }

    function tileFor(photoId: string | undefined): HTMLElement | null {
        return photoId ? rootEl?.querySelector<HTMLElement>(`[data-timeline-photo-id="${CSS.escape(photoId)}"]`) ?? null : null;
    }

    async function focusPhoto(photo: Photo | undefined) {
        if (!photo) return;
        selectPhoto(photo);
        await tick();
        const tile = tileFor(photo.id);
        tile?.focus({ preventScroll: true });
        tile?.scrollIntoView({ block: "nearest" });
    }

    /** The closest tile in the next row up or down, by position: day sections end on ragged rows. */
    function verticalNeighbor(current: Photo, direction: 1 | -1): Photo | undefined {
        const from = tileFor(current.id)?.getBoundingClientRect();
        if (!from || !rootEl) return undefined;
        let best: { id: string; dy: number; dx: number } | null = null;
        for (const tile of rootEl.querySelectorAll<HTMLElement>("[data-timeline-photo-id]")) {
            const rect = tile.getBoundingClientRect();
            const dy = (rect.top - from.top) * direction;
            if (dy <= 1) continue;
            const dx = Math.abs(rect.left - from.left);
            if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) {
                best = { id: tile.dataset.timelinePhotoId!, dy, dx };
            }
        }
        return best ? visualOrder.find((photo) => photo.id === best!.id) : undefined;
    }

    function handleKeydown(event: KeyboardEvent) {
        if ($viewMode === "viewer" || shouldIgnoreShortcut(event) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (keepsNativeActivation(event)) return;
        const current = photos[$selectedIndex];
        if (!current) return;
        const position = visualOrder.findIndex((photo) => photo.id === current.id);

        const moves: Record<string, () => Photo | undefined> = {
            ArrowRight: () => visualOrder[position + 1],
            ArrowLeft: () => visualOrder[position - 1],
            ArrowDown: () => verticalNeighbor(current, 1),
            ArrowUp: () => verticalNeighbor(current, -1),
            Home: () => visualOrder[0],
            End: () => visualOrder.at(-1),
        };
        if (moves[event.key]) {
            event.preventDefault();
            void focusPhoto(moves[event.key]());
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPhoto(current);
            return;
        }
        const cull = cullKeyAction(event);
        if (!cull) return;
        event.preventDefault();
        for (const id of [current.id, current.paired_with].filter(Boolean) as string[]) {
            if (cull.flag) photoStore.setPhotoFlag(id, cull.flag);
            if (cull.rating !== undefined) photoStore.setPhotoRating(id, cull.rating);
        }
        if (cull.advance) void focusPhoto(visualOrder[position + 1]);
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div bind:this={rootEl} class="h-full overflow-y-auto px-5 py-4">
    <div class="mx-auto flex max-w-7xl flex-col gap-6">
        {#each groupedPhotos as group (group.key)}
            <section class="min-w-0">
                <div class="sticky top-0 z-10 mb-3 flex items-center gap-3 border-b border-border bg-background/95 py-2 backdrop-blur">
                    <CalendarDays size={16} class="text-primary" />
                    <h2 class="text-sm font-semibold text-foreground">{group.label}</h2>
                    <span class="text-xs tabular-nums text-muted-foreground">{group.items.length} frames</span>
                </div>

                <div
                    class="grid grid-cols-[repeat(auto-fill,minmax(var(--timeline-tile-min),1fr))] gap-3"
                    style={`--timeline-tile-min: ${timelineTileMinWidth}px`}
                >
                    {#each group.items as photo (photo.id)}
                        {@const embeddedPreview = embeddedPreviewInfo(photo)}
                        {@const index = globalIndex(photo)}
                        <button
                            class="photo-tile group relative overflow-hidden rounded-lg border bg-card text-left transition-colors {index === $selectedIndex ? 'border-primary' : 'border-border hover:border-primary/60'}"
                            onclick={() => selectPhoto(photo)}
                            ondblclick={() => openPhoto(photo)}
                            onkeydown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openPhoto(photo);
                                }
                            }}
                            title={photo.file_name}
                            data-timeline-photo-id={photo.id}
                        >
                            <div class="relative aspect-[3/2] bg-black">
                                <PhotoPreview {photo} fit="contain" iconSize={28} />

                                <div class="absolute right-2 top-2 flex gap-1">
                                    {#if photo.paired_with}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                                            <FileImage size={12} />
                                        </span>
                                    {/if}
                                    {#if embeddedPreview && index === $selectedIndex}
                                        <span
                                            class="grid h-5 w-5 place-items-center rounded-full bg-primary/90 text-primary-foreground"
                                            title={embeddedPreviewTitle(embeddedPreview)}
                                            aria-label="RAW includes embedded JPEG preview"
                                        >
                                            <Info size={12} />
                                        </span>
                                    {/if}
                                    {#if photo.flag === "pick"}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-pick text-black">
                                            <Check size={12} />
                                        </span>
                                    {:else if photo.flag === "reject"}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-reject text-white">
                                            <XCircle size={12} />
                                        </span>
                                    {/if}
                                </div>
                            </div>
                            <div class="min-w-0 px-2 py-2">
                                <div class="truncate text-xs font-semibold text-foreground">{photo.file_name}</div>
                                <div class="truncate text-[11px] text-muted-foreground">{photo.exif.camera_model ?? photo.file_type}</div>
                            </div>
                        </button>
                    {/each}
                </div>
            </section>
        {/each}
    </div>
</div>
