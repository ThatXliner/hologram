<script lang="ts">
    import { onMount, untrack } from "svelte";
    import {
        photoStore,
        photos,
        libraryPhotos,
        filteredPhotos,
        displayPhotos,
        viewMode,
        isLoading,
        selectedIndex,
    } from "../lib/stores/photoStore.ts";
    import PhotoGrid from "../lib/components/PhotoGrid.svelte";
    import AutoCullView from "../lib/components/AutoCullView.svelte";
    import TimelineView from "../lib/components/TimelineView.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import ExportPanel from "../lib/components/ExportPanel.svelte";
    import SettingsPanel from "../lib/components/SettingsPanel.svelte";
    import { HologramAPI } from "../lib/api.ts";
    import { buildSmartCollections } from "../lib/collections.ts";
    import { indexPhotoVisuals } from "../lib/visualIndex.ts";
    import { photoPreviewSrc } from "../lib/photoPreview.ts";
    import type { CullFlag, Photo, PhotoDecisionHandler, PhotoFilter, SavedSearch, ThumbnailReady, VisualIndexEntry, VisualIndexProgress } from "../lib/types.ts";
    import {
        Check,
        Circle,
        Download,
        FolderOpen,
        ArrowRight,
        Keyboard,
        LayoutGrid,
        Loader2,
        Minus,
        Plus,
        PanelLeft,
        Save,
        Search,
        Settings,
        Sparkles,
        SlidersHorizontal,
        Star,
        X,
    } from "@lucide/svelte";

    type CullFilter = "all" | CullFlag;
    type LegacyDensity = "compact" | "balanced" | "large" | "lightbox";
    type GridDetails = "image" | "essentials" | "metadata";
    type LibraryView = "grid" | "timeline";
    type RailView = "library" | "autocull" | "export" | "settings";
    type ExportContext = { kind: "library" } | { kind: "autocull"; folderPath: string | null; photoIds: string[] };
    const GRID_PREFERENCES_KEY = "hologram.gridPreferences";
    const GRID_ZOOM_STEPS = [120, 150, 180, 220, 270, 340, 430, 520] as const;
    const DEFAULT_GRID_ZOOM_LEVEL = 3;

    let searchQuery = $state("");
    let sidebarFilter = $state<PhotoFilter>({});
    let cullFilter = $state<CullFilter>("all");
    let minRating = $state(0);
    let hideRejects = $state(false);
    let gridZoomLevel = $state(DEFAULT_GRID_ZOOM_LEVEL);
    let gridDetailMode = $state<GridDetails>("metadata");
    let libraryView = $state<LibraryView>("grid");
    let railView = $state<RailView>("library");
    let autoCullVisited = $state(false);
    let exportContext = $state<ExportContext>({ kind: "library" });
    let searchInput = $state<HTMLInputElement>();
    let savedSearches = $state<SavedSearch[]>([]);
    let activeSavedSearchId = $state<string | null>(null);
    let savedSearchName = $state("");
    let activeSmartCollectionId = $state<string | null>(null);
    let didLoadGridPreferences = $state(false);
    let smartCollectionsEnabled = $state(false);
    let smartCollectionsDialog = $state<HTMLDialogElement>();
    let isVisualIndexing = $state(false);
    let visualIndex = $state<Record<string, VisualIndexEntry>>({});
    let visualIndexProgress = $state<VisualIndexProgress>({ current: 0, total: 0 });
    let visualIndexLibraryKey = $state("");
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let folderPath = $state("");
    let importError = $state("");
    let showSidebar = $state(false);
    let saveSearchDialog = $state<HTMLDialogElement>();
    let shortcutsDialog = $state<HTMLDialogElement>();
    let viewOptions = $state<HTMLDetailsElement>();

    const searchCache = new Map<string, { key: string; text: string }>();
    let lastReviewState = "";

    const hasLibrary = $derived($photos.length > 0);
    const exportPhotos = $derived.by(() => {
        if (exportContext.kind === "library") return $displayPhotos;
        if (exportContext.folderPath !== HologramAPI.getActiveFolderPath()) return [];
        const ids = new Set(exportContext.photoIds);
        return $photos.filter((photo) => ids.has(photo.id) && photo.flag === "pick");
    });
    const keeperDestination = $derived(exportContext.kind === "autocull" && exportContext.folderPath
        ? `${exportContext.folderPath.replace(/[\\/]$/, "")}/culled` : "");

    function exportKeepers(photoIds: string[]) {
        exportContext = { kind: "autocull", folderPath: HologramAPI.getActiveFolderPath(), photoIds };
        railView = "export";
    }

    function openLibraryExport() {
        exportContext = { kind: "library" };
        railView = "export";
    }

    const cursorPhoto = $derived($displayPhotos[$selectedIndex]);
    const smartCollections = $derived(
        smartCollectionsEnabled ? buildSmartCollections($photos, visualIndex) : [],
    );
    const gridTileSize = $derived(GRID_ZOOM_STEPS[gridZoomLevel] ?? GRID_ZOOM_STEPS[DEFAULT_GRID_ZOOM_LEVEL]);
    const maxGridZoomLevel = GRID_ZOOM_STEPS.length - 1;

    // Session totals are library-wide (independent of the active filter), for the HUD.
    const sessionPicks = $derived($libraryPhotos.filter((photo) => photo.flag === "pick").length);
    const sessionRejects = $derived($libraryPhotos.filter((photo) => photo.flag === "reject").length);
    const sessionUnmarked = $derived($libraryPhotos.filter((photo) => !photo.flag || photo.flag === "none").length);
    const effectiveRail = $derived<RailView>(hasLibrary || railView === "settings" ? railView : "library");
    const folderName = $derived(folderPath.split(/[\\/]/).filter(Boolean).at(-1) || "Photo library");
    const filterLabels: Record<string, string> = {
        camera_make: "Camera make", camera_model: "Camera", lens_model: "Lens", file_type: "File type",
        shutter_speed: "Shutter", exposure_mode: "Exposure", flash: "Flash", white_balance: "White balance",
        iso_range: "ISO", aperture_range: "Aperture", focal_length_range: "Focal length", date_range: "Date", tags: "Tags",
    };
    const activeFilterChips = $derived([
        ...(searchQuery.trim() ? [{ key: "search", label: `Search: ${searchQuery.trim()}` }] : []),
        ...(cullFilter !== "all" ? [{ key: "flag", label: cullFilter === "pick" ? "Picks" : cullFilter === "reject" ? "Rejects" : "Unmarked" }] : []),
        ...(minRating > 0 ? [{ key: "rating", label: `${minRating}+ stars` }] : []),
        ...(hideRejects && cullFilter !== "reject" ? [{ key: "hide", label: "Rejects hidden" }] : []),
        ...Object.entries(sidebarFilter).flatMap(([key, value]) => {
            if (!filterLabels[key] || value == null || value === "") return [];
            if (Array.isArray(value) && value.every((item) => item == null || item === "")) return [];
            const label = Array.isArray(value) ? value.map((item) => item ?? "Any").join(key === "tags" ? ", " : " to ") : String(value);
            return [{ key, label: `${filterLabels[key]}: ${label}` }];
        }),
        ...(activeSmartCollectionId ? [{ key: "collection", label: smartCollections.find((item) => item.id === activeSmartCollectionId)?.name ?? "Smart collection" }] : []),
    ]);

    $effect(() => {
        if (!hasLibrary) autoCullVisited = false;
        else if (effectiveRail === "autocull") autoCullVisited = true;
    });
    
    let previewScopeIds = $state<string[] | null>(null);
    let previewStartIndex = $state(0);
    let previewConfirmCluster = $state<(() => void) | null>(null);
    let previewPreloadIds = $state<string[]>([]);
    let previewDecision = $state<PhotoDecisionHandler | null>(null);
    const previewPhotos = $derived(
        previewScopeIds
            ? previewScopeIds
                  .map((id) => $displayPhotos.find((photo) => photo.id === id))
                  .filter((photo): photo is Photo => Boolean(photo))
            : $displayPhotos,
    );
    const previewPreloadPhotos = $derived(
        previewPreloadIds
            .map((id) => $displayPhotos.find((photo) => photo.id === id))
            .filter((photo): photo is Photo => Boolean(photo)),
    );

    function openScopedPreview(
        photoIds: string[],
        selectedPhotoId: string,
        onConfirmCluster?: () => void,
        preloadPhotoIds: string[] = [],
        onDecision?: PhotoDecisionHandler,
    ) {
        previewScopeIds = photoIds;
        previewStartIndex = Math.max(0, photoIds.indexOf(selectedPhotoId));
        previewConfirmCluster = onConfirmCluster ?? null;
        previewPreloadIds = preloadPhotoIds;
        previewDecision = onDecision ?? null;
        photoStore.setViewMode("viewer");
    }

    $effect(() => {
        if ($viewMode !== "viewer") {
            previewScopeIds = null;
            previewConfirmCluster = null;
            previewDecision = null;
            previewPreloadIds = [];
        }
    });

    function clearAllFilters() {
        if (searchTimer) clearTimeout(searchTimer);
        searchQuery = "";
        sidebarFilter = {};
        cullFilter = "all";
        minRating = 0;
        hideRejects = false;
        activeSavedSearchId = null;
        activeSmartCollectionId = null;
        savedSearchName = "";
        applyAllFilters();
    }

    function removeFilterChip(key: string) {
        if (searchTimer) clearTimeout(searchTimer);
        if (key === "search") searchQuery = "";
        else if (key === "flag") cullFilter = "all";
        else if (key === "rating") minRating = 0;
        else if (key === "hide") hideRejects = false;
        else if (key === "collection") activeSmartCollectionId = null;
        else {
            const next = { ...sidebarFilter };
            delete next[key as keyof PhotoFilter];
            sidebarFilter = next;
        }
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function openSelectedPhoto() {
        if (cursorPhoto) photoStore.setViewMode("viewer");
    }

    function flagSelectedPhoto(flag: CullFlag) {
        if (!cursorPhoto) return;
        for (const id of [cursorPhoto.id, cursorPhoto.paired_with].filter(Boolean) as string[]) {
            photoStore.setPhotoFlag(id, flag);
        }
    }

    function handleLibraryKeydown(event: KeyboardEvent) {
        if ($viewMode === "viewer" || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement;
        if (event.key === "Escape" && !target.closest("dialog")) {
            if (viewOptions?.open) viewOptions.open = false;
            else if (window.innerWidth < 1100) showSidebar = false;
            return;
        }
        if (target.closest("input, textarea, select, dialog, [contenteditable=true]")) return;
        if (event.key === "/" && effectiveRail === "library" && hasLibrary) {
            event.preventDefault();
            searchInput?.focus();
        } else if (event.key === "?") {
            event.preventDefault();
            shortcutsDialog?.showModal();
        }
    }

    onMount(() => {
        showSidebar = window.innerWidth >= 1100;
        loadSavedSearches();
        loadSmartCollectionState();
        loadGridPreferences();
        didLoadGridPreferences = true;
        if (import.meta.env.DEV) {
            (window as any).__photoStore__ = photoStore;
            const seedHandler = ((e: CustomEvent) => {
                const { photos: seedPhotos, stats: seedStats } = e.detail;
                photoStore.setPhotos(seedPhotos);
                photoStore.setStats(seedStats);
                photoStore.loadMetadata(seedPhotos.map((photo: Photo) => photo.id));
            }) as EventListener;
            window.addEventListener("__hologram_seed__", seedHandler);
            return () => window.removeEventListener("__hologram_seed__", seedHandler);
        }
    });

    $effect(() => {
        if (!didLoadGridPreferences) return;
        localStorage.setItem(
            GRID_PREFERENCES_KEY,
            JSON.stringify({ zoomLevel: gridZoomLevel, detailMode: gridDetailMode }),
        );
    });

    $effect(() => {
        const ids = $photos.map((photo) => photo.id).join("|");
        if (!smartCollectionsEnabled || !ids || isVisualIndexing || ids === visualIndexLibraryKey) return;
        visualIndexLibraryKey = ids;
        void startVisualIndexing($photos);
    });

    $effect(() => {
        const count = $displayPhotos.length;
        const index = $selectedIndex;
        if (count > 0 && index >= count) {
            photoStore.setSelectedIndex(count - 1);
        }
    });

    function handleSidebarFilter(filter: PhotoFilter) {
        sidebarFilter = filter;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    // Keep a review sequence stable while the viewer is open. Refresh the library
    // after decisions change, retaining the cursor even when a photo is filtered out.
    $effect(() => {
        if ($viewMode === "viewer") return;
        const reviewState = JSON.stringify($photos.map((photo) => [photo.id, photo.flag, photo.rating, photo.tags, photo.notes]));
        if (reviewState === lastReviewState) return;
        lastReviewState = reviewState;
        untrack(() => applyAllFilters(true));
    });

    function handleSearchInput() {
        if (searchTimer) clearTimeout(searchTimer);
        activeSavedSearchId = null;
        searchTimer = setTimeout(applyAllFilters, 140);
    }

    function setCullFilter(next: CullFilter) {
        cullFilter = next;
        if (next === "reject") hideRejects = false;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function setMinRating(next: number) {
        minRating = next;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function toggleHideRejects() {
        hideRejects = !hideRejects;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function setGridZoomLevel(next: number) {
        gridZoomLevel = Math.max(0, Math.min(maxGridZoomLevel, Math.round(next)));
    }

    function adjustGridZoom(delta: number) {
        setGridZoomLevel(gridZoomLevel + delta);
    }

    function setGridDetailMode(next: GridDetails) {
        gridDetailMode = next;
    }

    function resetGridPreferences() {
        gridZoomLevel = DEFAULT_GRID_ZOOM_LEVEL;
        gridDetailMode = "metadata";
    }

    function isLegacyDensity(value: unknown): value is LegacyDensity {
        return value === "compact" || value === "balanced" || value === "large" || value === "lightbox";
    }

    function isGridDetails(value: unknown): value is GridDetails {
        return value === "image" || value === "essentials" || value === "metadata";
    }

    function zoomLevelFromDensity(value: unknown): number | null {
        if (!isLegacyDensity(value)) return null;
        if (value === "compact") return 1;
        if (value === "large") return 4;
        if (value === "lightbox") return maxGridZoomLevel;
        return DEFAULT_GRID_ZOOM_LEVEL;
    }

    function loadGridPreferences() {
        try {
            const raw = localStorage.getItem(GRID_PREFERENCES_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw) as { zoomLevel?: unknown; density?: unknown; detailMode?: unknown };
            if (typeof saved.zoomLevel === "number") {
                setGridZoomLevel(saved.zoomLevel);
            } else {
                const migratedZoomLevel = zoomLevelFromDensity(saved.density);
                if (migratedZoomLevel != null) setGridZoomLevel(migratedZoomLevel);
            }
            if (isGridDetails(saved.detailMode)) gridDetailMode = saved.detailMode;
        } catch {
            gridZoomLevel = DEFAULT_GRID_ZOOM_LEVEL;
            gridDetailMode = "metadata";
        }
    }

    function loadSavedSearches() {
        try {
            const raw = localStorage.getItem("hologram.savedSearches");
            savedSearches = raw ? JSON.parse(raw) : [];
        } catch {
            savedSearches = [];
        }
    }

    function persistSavedSearches(next: SavedSearch[]) {
        savedSearches = next;
        localStorage.setItem("hologram.savedSearches", JSON.stringify(next));
    }

    function saveCurrentSearch() {
        const now = new Date().toISOString();
        const existing = activeSavedSearchId ? savedSearches.find((search) => search.id === activeSavedSearchId) : undefined;
        const name = savedSearchName.trim() || searchQuery.trim() || existing?.name || `Search ${savedSearches.length + 1}`;
        const saved: SavedSearch = {
            id: existing?.id ?? crypto.randomUUID(),
            name,
            filter: sidebarFilter,
            search: searchQuery,
            cull_filter: cullFilter,
            min_rating: minRating,
            hide_rejects: hideRejects,
            created_at: existing?.created_at ?? now,
            updated_at: now,
        };
        persistSavedSearches([saved, ...savedSearches.filter((item) => item.id !== saved.id)]);
        activeSavedSearchId = saved.id;
        savedSearchName = saved.name;
        saveSearchDialog?.close();
    }

    function selectSavedSearch(id: string) {
        const saved = savedSearches.find((item) => item.id === id);
        if (!saved) return;
        activeSavedSearchId = saved.id;
        savedSearchName = saved.name;
        sidebarFilter = { ...saved.filter };
        searchQuery = saved.search;
        cullFilter = saved.cull_filter;
        minRating = saved.min_rating;
        hideRejects = saved.hide_rejects;
        activeSmartCollectionId = null;
        applyAllFilters();
    }

    function deleteSavedSearch(id: string) {
        persistSavedSearches(savedSearches.filter((item) => item.id !== id));
        if (activeSavedSearchId === id) {
            activeSavedSearchId = null;
            savedSearchName = "";
        }
    }

    function selectSmartCollection(id: string | null) {
        if (!smartCollectionsEnabled) {
            smartCollectionsDialog?.showModal();
            return;
        }
        activeSmartCollectionId = id;
        applyAllFilters();
    }

    function loadSmartCollectionState() {
        smartCollectionsEnabled = localStorage.getItem("hologram.smartCollections.enabled") === "true";
        try {
            const raw = localStorage.getItem("hologram.visualIndex");
            visualIndex = raw ? JSON.parse(raw) : {};
        } catch {
            visualIndex = {};
        }
    }

    function persistVisualIndex(entries: Record<string, VisualIndexEntry>) {
        visualIndex = entries;
        localStorage.setItem("hologram.visualIndex", JSON.stringify(entries));
    }

    function openSmartCollectionsModal() {
        if (smartCollectionsEnabled) return;
        smartCollectionsDialog?.showModal();
    }

    function enableSmartCollections() {
        smartCollectionsEnabled = true;
        localStorage.setItem("hologram.smartCollections.enabled", "true");
        smartCollectionsDialog?.close();
        activeSmartCollectionId = null;
        if ($photos.length > 0) {
            visualIndexLibraryKey = $photos.map((photo) => photo.id).join("|");
            void startVisualIndexing($photos);
        }
    }

    function setSmartCollectionsEnabled(enabled: boolean) {
        if (enabled) {
            enableSmartCollections();
            return;
        }
        smartCollectionsEnabled = false;
        activeSmartCollectionId = null;
        localStorage.setItem("hologram.smartCollections.enabled", "false");
        applyAllFilters();
    }

    async function startVisualIndexing(items: Photo[]) {
        if (isVisualIndexing || items.length === 0) return;
        isVisualIndexing = true;
        visualIndexProgress = { current: 0, total: items.length };
        try {
            const entries = await indexPhotoVisuals(
                items,
                (progress) => {
                    visualIndexProgress = progress;
                },
                visualIndex,
            );
            persistVisualIndex(entries);
        } finally {
            isVisualIndexing = false;
        }
    }

    async function importFolder() {
        if ($isLoading) return;
        const selectedFolder = await HologramAPI.selectFolder();
        if (!selectedFolder) return;
        const previousFolder = HologramAPI.getActiveFolderPath();
        importError = "";
        try {
            photoStore.setLoading(true);
            const result = await HologramAPI.scanFolder(
                selectedFolder,
                (data: ThumbnailReady) => {
                    photoStore.setThumbnail(data.id, data.thumbnail, data.embedded_jpeg_preview);
                },
            );
            photoStore.setPhotos(result.photos);
            photoStore.setStats(result.stats);
            folderPath = selectedFolder;
            exportContext = { kind: "library" };
            searchCache.clear();
            clearAllFilters();
            railView = "library";
            photoStore.loadMetadata(result.photos.map((photo) => photo.id));
        } catch (error) {
            HologramAPI.setActiveFolderPath(previousFolder);
            importError = `Could not open this folder. Check that it is available and that Hologram has permission to read it. ${String(error)}`;
            console.error("Failed to import folder:", error);
        } finally {
            photoStore.setLoading(false);
        }
    }

    function applyAllFilters(preserveSelection = false) {
        const selectedPhotoId = cursorPhoto?.id;
        const previousIndex = $selectedIndex;
        const filter: PhotoFilter = {
            ...sidebarFilter,
            search: searchQuery.trim() || undefined,
            rating_gte: minRating > 0 ? minRating : undefined,
            flag: cullFilter !== "all" ? cullFilter : undefined,
        };
        const allPhotos = photoStore.photos || [];
        const activeCollection = activeSmartCollectionId
            ? smartCollections.find((collection) => collection.id === activeSmartCollectionId)
            : null;
        const smartPhotoIds = activeCollection ? new Set(activeCollection.photo_ids) : null;
        photoStore.setFilter(filter);

        const filtered = allPhotos.filter((photo) => {
            const flag = photo.flag ?? "none";
            const rating = photo.rating ?? 0;

            if (smartPhotoIds && !smartPhotoIds.has(photo.id) && !(photo.paired_with && smartPhotoIds.has(photo.paired_with))) return false;
            if (hideRejects && filter.flag !== "reject" && flag === "reject") return false;
            if (filter.flag && flag !== filter.flag) return false;
            if (filter.rating_gte && rating < filter.rating_gte) return false;

            if (filter.search) {
                const q = filter.search.toLowerCase();
                if (!getSearchText(photo).includes(q)) return false;
            }

            if (filter.camera_make && (!photo.exif.camera_make || !photo.exif.camera_make.includes(filter.camera_make))) return false;
            if (filter.camera_model && (!photo.exif.camera_model || !photo.exif.camera_model.includes(filter.camera_model))) return false;
            if (filter.lens_model && (!photo.exif.lens_model || !photo.exif.lens_model.includes(filter.lens_model))) return false;
            if (filter.file_type && photo.file_type !== filter.file_type) return false;
            if (filter.shutter_speed && photo.exif.shutter_speed !== filter.shutter_speed) return false;
            if (filter.exposure_mode && photo.exif.exposure_mode !== filter.exposure_mode) return false;
            if (filter.flash && photo.exif.flash !== filter.flash) return false;
            if (filter.white_balance && photo.exif.white_balance !== filter.white_balance) return false;

            if (filter.iso_range) {
                if (!photo.exif.iso) return false;
                if (filter.iso_range[0] != null && photo.exif.iso < filter.iso_range[0]) return false;
                if (filter.iso_range[1] != null && photo.exif.iso > filter.iso_range[1]) return false;
            }
            if (filter.aperture_range) {
                if (!photo.exif.aperture) return false;
                if (filter.aperture_range[0] != null && photo.exif.aperture < filter.aperture_range[0]) return false;
                if (filter.aperture_range[1] != null && photo.exif.aperture > filter.aperture_range[1]) return false;
            }
            if (filter.focal_length_range) {
                if (!photo.exif.focal_length) return false;
                if (filter.focal_length_range[0] != null && photo.exif.focal_length < filter.focal_length_range[0]) return false;
                if (filter.focal_length_range[1] != null && photo.exif.focal_length > filter.focal_length_range[1]) return false;
            }
            if (filter.date_range) {
                if (!photo.exif.date_taken) return false;
                if (filter.date_range[0] && photo.exif.date_taken < filter.date_range[0]) return false;
                if (filter.date_range[1] && photo.exif.date_taken > filter.date_range[1]) return false;
            }
            if (filter.tags && filter.tags.length > 0) {
                const photoTags = photo.tags ?? [];
                if (!filter.tags.every((tag) => photoTags.includes(tag))) return false;
            }
            return true;
        });

        photoStore.setFilteredPhotos(filtered);
        const retainedIndex = preserveSelection ? $displayPhotos.findIndex((photo) => photo.id === selectedPhotoId) : -1;
        photoStore.setSelectedIndex(retainedIndex >= 0 ? retainedIndex : preserveSelection ? Math.min(previousIndex, Math.max(0, $displayPhotos.length - 1)) : 0);
    }

    function getSearchText(photo: Photo): string {
        const key = [
            photo.file_name,
            photo.exif.camera_make,
            photo.exif.camera_model,
            photo.exif.lens_model,
            photo.exif.shutter_speed,
            photo.exif.exposure_mode,
            photo.exif.flash,
            photo.exif.white_balance,
            photo.exif.date_taken,
            photo.file_type,
            (photo.tags ?? []).join(" "),
            photo.notes,
            photo.rating,
            photo.flag,
        ].filter(Boolean).join("\u0001");
        const cached = searchCache.get(photo.id);
        if (cached?.key === key) return cached.text;
        const text = key.toLowerCase();
        searchCache.set(photo.id, { key, text });
        return text;
    }

</script>

<svelte:head>
    <title>Hologram · Photo library</title>
</svelte:head>

<svelte:window onkeydown={handleLibraryKeydown} onpointerdown={(event) => { if (viewOptions?.open && !viewOptions.contains(event.target as Node)) viewOptions.open = false; }} />

{#snippet railBtn(Icon: any, active: boolean, label: string, onclick: () => void, disabled = false)}
    <button
        class="relative flex h-[60px] w-16 flex-col items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 {active ? 'bg-secondary text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}"
        {onclick}
        {disabled}
        title={disabled ? `Open a photo folder to use ${label}` : label}
        aria-label={label}
        aria-pressed={active}
    >
        <Icon size={19} />
        <span>{label}</span>
    </button>
{/snippet}

{#snippet exportScreen()}
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-3 text-xs text-muted-foreground">
            {#if exportContext.kind === "autocull"}
                <button class="ui-control" onclick={() => (railView = "autocull")}>Back to AutoCull</button>
                <span>Export AutoCull keepers · {exportPhotos.length} kept photos</span>
            {:else}
                <button class="ui-control" onclick={() => (railView = "library")}>Back to library</button>
                <span>{activeFilterChips.length ? "Exporting the filtered library" : "Exporting all photos"} · {exportPhotos.length} photos</span>
                {#if activeFilterChips.length}<span class="truncate">({activeFilterChips.map((chip) => chip.label).join(" · ")})</span>{/if}
            {/if}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
            {#key exportContext}
                <ExportPanel photos={exportPhotos} allPhotos={$photos} keepers={exportContext.kind === "autocull"} defaultDestination={keeperDestination} />
            {/key}
        </div>
    </div>
{/snippet}

<div class="flex h-screen overflow-hidden bg-background text-foreground">
    <nav aria-label="Main navigation" class="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-border bg-rail py-4">
        <div class="mb-6 mt-1 h-5 w-5 rotate-45 rounded border-2 border-primary" title="Hologram"></div>
        {@render railBtn(LayoutGrid, effectiveRail === "library", "Library", () => (railView = "library"))}
        {@render railBtn(Sparkles, effectiveRail === "autocull", "AutoCull", () => (railView = "autocull"), !hasLibrary)}
        {@render railBtn(Download, effectiveRail === "export", "Export", openLibraryExport, !hasLibrary)}
        <div class="flex-1"></div>
        {@render railBtn(Keyboard, false, "Shortcuts", () => shortcutsDialog?.showModal())}
        {@render railBtn(Settings, effectiveRail === "settings", "Settings", () => (railView = "settings"))}
    </nav>

    {#if autoCullVisited && hasLibrary}
        <div class="min-w-0 flex-1 overflow-y-auto bg-background" hidden={effectiveRail !== "autocull"} inert={effectiveRail !== "autocull"}>
            <AutoCullView photos={$displayPhotos} allPhotos={$photos} active={effectiveRail === "autocull"} onOpenPreview={openScopedPreview} onExportKeepers={exportKeepers} />
        </div>
    {/if}

    {#if effectiveRail === "settings"}
        <SettingsPanel
            {gridZoomLevel} {maxGridZoomLevel} {gridTileSize} {gridDetailMode} {smartCollectionsEnabled}
            onGridZoomChange={setGridZoomLevel}
            onGridDetailChange={setGridDetailMode}
            onSmartCollectionsChange={setSmartCollectionsEnabled}
            onResetGridPreferences={resetGridPreferences}
        />
    {:else if effectiveRail === "export"}
        {@render exportScreen()}
    {:else if effectiveRail === "library"}
        {#if hasLibrary && showSidebar}
            <button class="sidebar-scrim" aria-label="Close filters" onclick={() => (showSidebar = false)}></button>
            <div class="library-sidebar">
                <Sidebar
                    photos={$displayPhotos} allPhotos={$photos} filter={sidebarFilter}
                    {folderName} {folderPath} onImport={importFolder} onClose={() => (showSidebar = false)}
                    savedSearches={savedSearches} activeSavedSearchId={activeSavedSearchId}
                    smartCollections={smartCollections} activeSmartCollectionId={activeSmartCollectionId}
                    smartCollectionsEnabled={smartCollectionsEnabled} smartCollectionsIndexing={isVisualIndexing}
                    visualIndexProgress={visualIndexProgress} onFilter={handleSidebarFilter}
                    onSavedSearchSelect={selectSavedSearch} onSavedSearchDelete={deleteSavedSearch}
                    onSmartCollectionSelect={selectSmartCollection} onSmartCollectionsTitleClick={openSmartCollectionsModal}
                />
            </div>
        {/if}

        <main class="flex min-w-0 flex-1 flex-col">
            {#if !hasLibrary}
                <header class="flex h-16 shrink-0 items-center border-b border-border px-7">
                    <span class="text-[15px] font-semibold">Hologram</span>
                    <span class="ml-3 text-xs text-muted-foreground">Your photo workspace</span>
                </header>
                <section class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
                    <div class="w-full max-w-[540px]">
                        <div class="mb-5 grid h-12 w-12 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><FolderOpen size={25} /></div>
                        <h1 class="text-[28px] font-semibold tracking-tight">{folderPath ? "No photos in this folder" : "Start with a folder of photos"}</h1>
                        <p class="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                            {folderPath ? `We couldn't find supported photos in ${folderName}. Choose another folder to get started.` : "Browse your shoot, choose your keepers, and export when you're ready. Your photos stay in their original folders."}
                        </p>
                        <button class="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60" onclick={importFolder} disabled={$isLoading}>
                            {#if $isLoading}<Loader2 size={17} class="animate-spin" /> Opening folder…{:else}<FolderOpen size={17} /> Open photo folder <ArrowRight size={16} />{/if}
                        </button>
                        {#if importError}<p role="alert" class="mt-4 rounded-lg border border-reject/30 bg-reject/5 p-3 text-sm text-reject">{importError}</p>{/if}
                        <p class="mt-3 text-xs text-muted-foreground">RAW, JPEG, TIFF, PNG and more · RAW+JPEG pairs stay together</p>
                        <div class="mt-9 grid grid-cols-3 gap-5 border-t border-border pt-6">
                            <div><span class="text-xs font-medium text-primary">01 / Browse</span><p class="mt-2 text-xs leading-relaxed text-muted-foreground">See your photos and filter by camera, lens or rating.</p></div>
                            <div><span class="text-xs font-medium text-primary">02 / Review</span><p class="mt-2 text-xs leading-relaxed text-muted-foreground">Open a photo. Mark picks and rejects as you go.</p></div>
                            <div><span class="text-xs font-medium text-primary">03 / Export</span><p class="mt-2 text-xs leading-relaxed text-muted-foreground">Filter to your picks, then save copies to a folder.</p></div>
                        </div>
                    </div>
                </section>
            {:else}
                <header class="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                    <button class="ui-control" onclick={() => (showSidebar = !showSidebar)} aria-expanded={showSidebar} aria-controls="library-filters" title="Show or hide library filters"><PanelLeft size={16} /> Filters</button>
                    <div class="min-w-0 flex-1">
                        <h1 class="truncate text-sm font-semibold" title={folderPath}>{folderName}</h1>
                        <p class="text-xs text-muted-foreground" aria-live="polite">{$displayPhotos.length} of {$libraryPhotos.length} photos{#if activeFilterChips.length} · Filtered{/if}</p>
                    </div>
                    <button class="ui-control" onclick={importFolder} disabled={$isLoading} aria-label="Open folder" title="Open another photo folder"><FolderOpen size={15} /><span class="hidden min-[950px]:inline">Open folder</span></button>
                    <button class="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40" onclick={openSelectedPhoto} disabled={!cursorPhoto || $isLoading}>
                        Review photo <ArrowRight size={14} />
                    </button>
                </header>

                {#if importError}
                    <div role="alert" class="flex items-center gap-3 border-b border-reject/20 bg-reject/5 px-4 py-3 text-xs text-reject"><span class="min-w-0 flex-1">{importError}</span><button aria-label="Dismiss import error" onclick={() => (importError = "")}><X size={16} /></button></div>
                {/if}
                {#if $isLoading}
                    <div role="status" class="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-muted-foreground"><Loader2 size={16} class="animate-spin" /> Opening photo folder…</div>
                {/if}

                <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                    <div class="relative min-w-[180px] flex-1">
                        <Search size={15} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input bind:this={searchInput} type="text" aria-label="Search photos" placeholder="Search photos, cameras, tags…" class="h-9 w-full rounded-md border border-input bg-popover pl-9 pr-9 text-xs outline-none placeholder:text-muted-foreground focus:border-primary" bind:value={searchQuery} oninput={handleSearchInput} />
                        {#if searchQuery}<button class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search" onclick={() => removeFilterChip("search")}><X size={14} /></button>
                        {:else}<kbd class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">/</kbd>{/if}
                    </div>
                    <div class="inline-flex h-9 shrink-0 items-center rounded-md border border-border p-0.5" aria-label="Library view">
                        <button class="view-button {libraryView === 'grid' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}" aria-pressed={libraryView === "grid"} onclick={() => (libraryView = "grid")}><LayoutGrid size={14} /> Grid</button>
                        <button class="view-button {libraryView === 'timeline' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}" aria-pressed={libraryView === "timeline"} onclick={() => (libraryView = "timeline")}>Timeline</button>
                    </div>
                    <details bind:this={viewOptions} class="relative">
                        <summary class="ui-control list-none"><SlidersHorizontal size={15} /> View options</summary>
                        <div class="absolute right-0 z-30 mt-2 w-64 space-y-4 rounded-lg border border-input bg-popover p-4 shadow-xl">
                            <label class="block text-xs font-medium" for="thumbnail-size">Thumbnail size</label>
                            <div class="flex items-center gap-2">
                                <button class="text-muted-foreground disabled:opacity-30" onclick={() => adjustGridZoom(-1)} disabled={gridZoomLevel === 0} aria-label="Smaller thumbnails"><Minus size={16} /></button>
                                <input id="thumbnail-size" class="grid-zoom-slider h-6 min-w-0 flex-1" type="range" min="0" max={maxGridZoomLevel} step="1" value={gridZoomLevel} oninput={(event) => setGridZoomLevel(Number(event.currentTarget.value))} />
                                <button class="text-muted-foreground disabled:opacity-30" onclick={() => adjustGridZoom(1)} disabled={gridZoomLevel === maxGridZoomLevel} aria-label="Larger thumbnails"><Plus size={16} /></button>
                            </div>
                            <label class="block text-xs font-medium" for="grid-details">Photo details</label>
                            <select id="grid-details" class="ui-select w-full" bind:value={gridDetailMode} disabled={libraryView !== "grid"}>
                                <option value="image">Images only</option><option value="essentials">Filename and rating</option><option value="metadata">Full metadata</option>
                            </select>
                            <label class="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={hideRejects} disabled={cullFilter === "reject"} onchange={toggleHideRejects} /> Hide rejected photos</label>
                        </div>
                    </details>
                </div>

                <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
                    <div class="flex flex-wrap items-center gap-1" aria-label="Filter by flag">
                        {#each [{ value: 'all', label: 'All photos', count: $libraryPhotos.length }, { value: 'pick', label: 'Picks', count: sessionPicks }, { value: 'reject', label: 'Rejects', count: sessionRejects }, { value: 'none', label: 'Unmarked', count: sessionUnmarked }] as item}
                            <button class="flag-filter {cullFilter === item.value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}" aria-pressed={cullFilter === item.value} onclick={() => setCullFilter(item.value as CullFilter)}>
                                {#if item.value === 'pick'}<Check size={13} class="text-pick" />{:else if item.value === 'reject'}<X size={13} class="text-reject" />{:else if item.value === 'none'}<Circle size={12} />{/if}
                                {item.label}<span class="font-mono text-[10px] opacity-70">{item.count}</span>
                            </button>
                        {/each}
                    </div>
                    <label class="ml-auto flex items-center gap-2 text-xs text-muted-foreground"><Star size={13} class="text-rating" /><select class="ui-select" aria-label="Minimum rating" bind:value={minRating} onchange={(event) => setMinRating(Number(event.currentTarget.value))}>
                        <option value={0}>Any rating</option>{#each [1, 2, 3, 4, 5] as rating}<option value={rating}>{rating}+ stars</option>{/each}
                    </select></label>
                </div>

                {#if activeFilterChips.length}
                    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-4 py-2">
                        {#each activeFilterChips as chip (chip.key)}
                            <button class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] text-primary hover:bg-primary/10" aria-label={`Remove ${chip.label} filter`} onclick={() => removeFilterChip(chip.key)}><span class="truncate">{chip.label}</span><X size={11} class="shrink-0" /></button>
                        {/each}
                        <button class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onclick={clearAllFilters}>Clear all</button>
                        {#if activeSavedSearchId}<span role="status" class="text-[11px] text-muted-foreground">Saved: {savedSearches.find((item) => item.id === activeSavedSearchId)?.name}</span>{/if}
                        <button class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onclick={() => { savedSearchName = activeSavedSearchId ? savedSearches.find((item) => item.id === activeSavedSearchId)?.name ?? "" : searchQuery; saveSearchDialog?.showModal(); }}><Save size={13} /> Save search</button>
                    </div>
                {/if}

                {#if $displayPhotos.length === 0}
                    <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-8 py-6 text-center">
                        <div class="max-w-sm"><Search size={28} class="mx-auto mb-3 text-muted-foreground" /><h2 class="text-base font-semibold">No photos match these filters</h2><p class="mt-2 text-sm leading-relaxed text-muted-foreground">Remove a filter above, or clear them all to see your whole library.</p><button class="mt-5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90" onclick={clearAllFilters}>Clear all filters</button></div>
                    </div>
                {:else}
                    <div class="min-h-0 flex-1 overflow-hidden">
                        {#if libraryView === "timeline"}<TimelineView photos={$displayPhotos} tileMinWidth={gridTileSize} />
                        {:else}<PhotoGrid photos={$displayPhotos} tileMinWidth={gridTileSize} detailMode={gridDetailMode} />{/if}
                    </div>
                    <footer class="shrink-0 border-t border-border bg-card px-4 py-2.5">
                        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                            {#if cursorPhoto}
                                <div class="flex min-w-0 flex-1 items-center gap-2.5">
                                    <div class="h-9 w-9 shrink-0 overflow-hidden rounded bg-secondary">{#if photoPreviewSrc(cursorPhoto)}<img src={photoPreviewSrc(cursorPhoto)} alt="" class="h-full w-full object-cover" />{/if}</div>
                                    <div class="min-w-0"><div class="truncate font-mono text-xs" title={cursorPhoto.file_name}>{cursorPhoto.file_name}</div><div class="mt-0.5 text-[11px] text-muted-foreground">Photo {$selectedIndex + 1} of {$displayPhotos.length}{#if cursorPhoto.paired_with} · RAW + JPEG{/if}</div></div>
                                </div>
                                <div class="flex items-center gap-1.5" aria-label="Selected photo actions">
                                    <button class="ui-control" class:active-pick={cursorPhoto.flag === "pick"} aria-pressed={cursorPhoto.flag === "pick"} onclick={() => flagSelectedPhoto("pick")}><Check size={14} /> Pick {#if libraryView === "grid"}<kbd>P</kbd>{/if}</button>
                                    <button class="ui-control" class:active-reject={cursorPhoto.flag === "reject"} aria-pressed={cursorPhoto.flag === "reject"} onclick={() => flagSelectedPhoto("reject")}><X size={14} /> Reject {#if libraryView === "grid"}<kbd>X</kbd>{/if}</button>
                                    <button class="ui-control" onclick={() => flagSelectedPhoto("none")} title="Clear selected photo flag"><Circle size={13} /> Unmark</button>
                                </div>
                            {/if}
                        </div>
                        <p class="mt-2 text-[11px] text-muted-foreground">Click to select · Double-click or press Space to review {#if libraryView === "grid"}<span class="hidden min-[1100px]:inline">· P / X mark and advance · 1–5 rate</span>{/if}</p>
                    </footer>
                {/if}
            {/if}
        </main>
    {/if}

    <dialog bind:this={saveSearchDialog} class="ui-dialog" aria-labelledby="save-search-title">
        <form onsubmit={(event) => { event.preventDefault(); saveCurrentSearch(); }}>
            <h2 id="save-search-title" class="text-lg font-semibold">Save this search</h2>
            <p class="mt-2 text-sm text-muted-foreground">Keep these filters in your sidebar so you can use them again.</p>
            <label for="search-name" class="mb-2 mt-5 block text-xs font-medium">Search name</label>
            <input id="search-name" class="ui-select w-full" bind:value={savedSearchName} placeholder="e.g. Portrait keepers" required />
            <div class="mt-6 flex justify-end gap-2"><button type="button" class="ui-control" onclick={() => saveSearchDialog?.close()}>Cancel</button><button class="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground" type="submit">Save search</button></div>
        </form>
    </dialog>
    <dialog bind:this={shortcutsDialog} class="ui-dialog" aria-labelledby="shortcuts-title">
        <div class="flex items-center justify-between"><h2 id="shortcuts-title" class="text-lg font-semibold">Keyboard shortcuts</h2><button class="ui-control" aria-label="Close keyboard shortcuts" onclick={() => shortcutsDialog?.close()}><X size={16} /></button></div>
        <p class="mt-2 text-sm text-muted-foreground">Select a photo in the grid to start. Picks, rejects and star ratings advance to the next photo.</p>
        <dl class="mt-5 space-y-3 text-sm">
            {#each [{ keys: '← ↑ ↓ →', action: 'Move through the grid' }, { keys: 'Space / Enter', action: 'Open selected photo' }, { keys: 'P / X', action: 'Pick / reject' }, { keys: 'U', action: 'Clear flag and rating' }, { keys: '0–5', action: 'Set star rating' }, { keys: '/', action: 'Search your library' }, { keys: 'Esc', action: 'Close a dialog or photo viewer' }] as shortcut}
                <div class="flex items-center justify-between gap-4"><dt class="text-muted-foreground">{shortcut.action}</dt><dd class="rounded border border-border bg-secondary px-2 py-1 font-mono text-xs">{shortcut.keys}</dd></div>
            {/each}
        </dl>
        <p class="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">In the photo viewer: R switches RAW / JPEG, D compares, E opens adjustments, and F fits the photo.</p>
    </dialog>

    <dialog bind:this={smartCollectionsDialog} class="ui-dialog" aria-labelledby="smart-collections-title">
                <div class="mb-4 flex items-start gap-3">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                        <Sparkles size={20} />
                    </div>
                    <div class="min-w-0">
                        <h2 id="smart-collections-title" class="text-base font-semibold text-foreground">Enable smart collections?</h2>
                        <p class="mt-1 text-sm text-muted-foreground">
                            Hologram will index previews locally in the background to build visual collections.
                        </p>
                    </div>
                </div>
                <div class="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
                    Collections help you find similar scenes and subjects across this folder. Indexing runs on your device, and your photos stay on your computer.
                </div>
                <div class="mt-5 flex justify-end gap-2">
                    <button
                        class="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onclick={() => smartCollectionsDialog?.close()}
                    >
                        Cancel
                    </button>
                    <button
                        class="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                        onclick={enableSmartCollections}
                    >
                        <Sparkles size={15} />
                        Enable Indexing
                    </button>
                </div>
    </dialog>

    {#if $viewMode === "viewer"}
        <PhotoViewer
            photos={previewPhotos}
            allPhotos={$filteredPhotos}
            startIndex={previewScopeIds ? previewStartIndex : $selectedIndex}
            onConfirmCluster={previewConfirmCluster}
            onDecision={previewDecision}
            backgroundPreloadPhotos={previewPreloadPhotos}
        />
    {/if}
</div>

<style>
    .ui-control { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; color: var(--muted-foreground); cursor: pointer; }
    .ui-control:hover { background: var(--secondary); color: var(--foreground); }
    .ui-control:disabled { opacity: .4; cursor: not-allowed; }
    .ui-control.active-pick { color: var(--pick); border-color: color-mix(in srgb, var(--pick) 40%, transparent); }
    .ui-control.active-reject { color: var(--reject); border-color: color-mix(in srgb, var(--reject) 40%, transparent); }
    .ui-control kbd { margin-left: 4px; font-size: 10px; opacity: .55; }
    .ui-select { height: 32px; min-width: 0; border: 1px solid var(--input); border-radius: 5px; padding: 0 8px; background: var(--popover); color: var(--foreground); font-size: 12px; }
    .view-button { display: flex; align-items: center; gap: 5px; height: 29px; padding: 0 9px; border-radius: 4px; font-size: 12px; }
    .flag-filter { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 9px; border-radius: 5px; font-size: 12px; white-space: nowrap; }
    .ui-dialog { position: fixed; inset: 0; width: min(440px, calc(100% - 32px)); max-height: calc(100vh - 48px); margin: auto; overflow-y: auto; padding: 24px; border: 1px solid var(--input); border-radius: 12px; background: var(--card); color: var(--foreground); box-shadow: 0 20px 80px #0008; }
    .ui-dialog::backdrop { background: #0009; }
    .library-sidebar { height: 100%; flex-shrink: 0; }
    .sidebar-scrim { display: none; }
    summary::-webkit-details-marker { display: none; }
    @media (max-width: 1099px) {
        .library-sidebar { position: fixed; left: 76px; top: 0; bottom: 0; z-index: 41; box-shadow: 15px 0 40px #0006; }
        .sidebar-scrim { display: block; position: fixed; inset: 0 0 0 76px; z-index: 40; background: #0007; }
    }
</style>
