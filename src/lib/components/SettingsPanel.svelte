<script lang="ts">
    import { Brain, LayoutGrid, RefreshCw, RotateCcw, Settings, Sparkles } from "@lucide/svelte";
    import { getVersion } from "@tauri-apps/api/app";
    import { onMount } from "svelte";
    import { MAX_REJECT_PERCENT, type TasteSettings } from "../tasteSettings.ts";
    import { checkForUpdates, installUpdate, updates } from "../updates.svelte.ts";

    type GridDetails = "image" | "essentials" | "metadata";

    interface Props {
        gridZoomLevel: number;
        maxGridZoomLevel: number;
        gridTileSize: number;
        gridDetailMode: GridDetails;
        smartCollectionsEnabled: boolean;
        tasteSettings: TasteSettings;
        onTasteSettingsChange: (settings: TasteSettings) => void;
        onGridZoomChange: (level: number) => void;
        onGridDetailChange: (mode: GridDetails) => void;
        onSmartCollectionsChange: (enabled: boolean) => void;
        onResetGridPreferences: () => void;
    }

    let {
        gridZoomLevel,
        maxGridZoomLevel,
        gridTileSize,
        gridDetailMode,
        smartCollectionsEnabled,
        tasteSettings,
        onTasteSettingsChange,
        onGridZoomChange,
        onGridDetailChange,
        onSmartCollectionsChange,
        onResetGridPreferences,
    }: Props = $props();

    let appVersion = $state("");
    onMount(() => {
        getVersion().then((version) => (appVersion = version)).catch(() => {});
    });

    const status = $derived(updates.status);
    const busy = $derived(status.kind === "checking" || status.kind === "downloading" || status.kind === "ready");
    const statusLine = $derived.by(() => {
        switch (status.kind) {
            case "idle": return "";
            case "checking": return "Checking for updates...";
            case "upToDate": return "Hologram is up to date.";
            case "available": return `Hologram ${status.version} is available.`;
            case "downloading": {
                const percent = status.total ? ` ${Math.min(100, Math.round((status.downloaded / status.total) * 100))}%` : "";
                return `Downloading update...${percent}`;
            }
            case "ready": return "Update installed. Restarting...";
            case "error": return `Update failed: ${status.message}`;
        }
    });

    const detailOptions: { value: GridDetails; label: string; description: string }[] = [
        { value: "image", label: "Images only", description: "Show the largest possible previews." },
        { value: "essentials", label: "Essentials", description: "Show filenames and ratings." },
        { value: "metadata", label: "Full metadata", description: "Show filenames, ratings, and exposure details." },
    ];
</script>

<main class="min-w-0 flex-1 overflow-y-auto bg-background">
    <header class="flex h-14 items-center gap-3 border-b border-border bg-card/70 px-5">
        <Settings size={18} class="text-primary" />
        <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.1em] text-primary">Hologram</div>
            <h1 class="text-sm font-semibold text-foreground">Settings</h1>
        </div>
    </header>

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
        <section class="rounded-lg border border-border bg-card">
            <div class="flex items-start gap-3 border-b border-border p-4">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                    <LayoutGrid size={17} />
                </div>
                <div>
                    <h2 class="text-sm font-semibold text-foreground">Grid appearance</h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">These choices are saved automatically.</p>
                </div>
            </div>

            <div class="space-y-5 p-4">
                <label class="block">
                    <span class="flex items-center justify-between text-xs font-medium text-foreground">
                        Thumbnail size
                        <span class="font-mono text-[11px] text-subtle">{gridTileSize}px</span>
                    </span>
                    <input
                        class="grid-zoom-slider mt-3 h-6 w-full"
                        type="range"
                        min="0"
                        max={maxGridZoomLevel}
                        step="1"
                        value={gridZoomLevel}
                        oninput={(event) => onGridZoomChange(Number(event.currentTarget.value))}
                    />
                </label>

                <fieldset>
                    <legend class="mb-2 text-xs font-medium text-foreground">Card details</legend>
                    <div class="grid gap-2 sm:grid-cols-3">
                        {#each detailOptions as option (option.value)}
                            <button
                                class="rounded-md border p-3 text-left transition-colors {gridDetailMode === option.value ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-secondary'}"
                                onclick={() => onGridDetailChange(option.value)}
                                aria-pressed={gridDetailMode === option.value}
                            >
                                <span class="block text-xs font-semibold text-foreground">{option.label}</span>
                                <span class="mt-1 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                            </button>
                        {/each}
                    </div>
                </fieldset>

                <button
                    class="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onclick={onResetGridPreferences}
                >
                    <RotateCcw size={13} />
                    Restore grid defaults
                </button>
            </div>
        </section>

        <section class="rounded-lg border border-border bg-card p-4">
            <div class="flex items-center gap-3">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-info/15 text-info">
                    <Sparkles size={17} />
                </div>
                <div class="min-w-0 flex-1">
                    <h2 class="text-sm font-semibold text-foreground">Smart Collections</h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">Analyze previews locally to create visual collections.</p>
                </div>
                <button
                    class="relative h-6 w-11 shrink-0 rounded-full transition-colors {smartCollectionsEnabled ? 'bg-primary' : 'bg-secondary'}"
                    onclick={() => onSmartCollectionsChange(!smartCollectionsEnabled)}
                    role="switch"
                    aria-checked={smartCollectionsEnabled}
                    aria-label="Smart Collections"
                >
                    <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all {smartCollectionsEnabled ? 'left-6' : 'left-1'}"></span>
                </button>
            </div>
        </section>

        <section class="rounded-lg border border-border bg-card" data-taste-settings>
            <div class="flex items-center gap-3 p-4">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                    <Brain size={17} />
                </div>
                <div class="min-w-0 flex-1">
                    <h2 class="text-sm font-semibold text-foreground">AutoCull taste model <span class="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Beta</span></h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">Ranks new shoots using image quality plus what you kept and rejected in past shoots. Downloads a 340 MB image model once; everything runs on this computer.</p>
                </div>
                <button
                    class="relative h-6 w-11 shrink-0 rounded-full transition-colors {tasteSettings.enabled ? 'bg-primary' : 'bg-secondary'}"
                    onclick={() => onTasteSettingsChange({ ...tasteSettings, enabled: !tasteSettings.enabled })}
                    role="switch"
                    aria-checked={tasteSettings.enabled}
                    aria-label="AutoCull taste model"
                >
                    <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all {tasteSettings.enabled ? 'left-6' : 'left-1'}"></span>
                </button>
            </div>
            {#if tasteSettings.enabled}
                <div class="border-t border-border p-4">
                    <label class="block">
                        <span class="flex items-center justify-between text-xs font-medium text-foreground">
                            Pre-mark as reject
                            <span class="font-mono text-[11px] text-subtle">{tasteSettings.rejectPercent === 0 ? "off" : `lowest ${tasteSettings.rejectPercent}%`}</span>
                        </span>
                        <input
                            class="grid-zoom-slider mt-3 h-6 w-full"
                            type="range"
                            min="0"
                            max={MAX_REJECT_PERCENT}
                            step="5"
                            value={tasteSettings.rejectPercent}
                            oninput={(event) => onTasteSettingsChange({ ...tasteSettings, rejectPercent: Number(event.currentTarget.value) })}
                        />
                    </label>
                    <p class="mt-2 text-[11px] leading-4 text-muted-foreground">How much of each shoot AutoCull marks as reject, lowest-ranked first. The next 10% are marked for review. Shoots differ a lot, so start low; you can undo any mark.</p>
                </div>
            {/if}
        </section>

        <section class="rounded-lg border border-border bg-card" data-update-settings>
            <div class="flex items-center gap-3 p-4">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                    <RefreshCw size={17} />
                </div>
                <div class="min-w-0 flex-1">
                    <h2 class="text-sm font-semibold text-foreground">Updates</h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">Hologram {appVersion || "..."}. Updates are signed and installed from GitHub releases.</p>
                </div>
                <button class="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40" disabled={busy} onclick={() => checkForUpdates({ silent: false })}>Check for updates</button>
            </div>
            {#if statusLine}
                <div class="flex items-center gap-3 border-t border-border p-4">
                    <p class="min-w-0 flex-1 text-xs {status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}" role="status">{statusLine}</p>
                    {#if status.kind === "available"}
                        <button class="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40" onclick={() => installUpdate()}>Install and restart</button>
                    {/if}
                </div>
            {/if}
        </section>
    </div>
</main>
