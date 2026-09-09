// Size thresholds for the large-file handling (L1/L2/L3 strategies).
// Kept in one module so the UI (App) and the tab store agree on "big".

/** Manual open asks for confirmation above this file size (bytes). */
export const LARGE_FILE_WARN_BYTES = 20 * 1024 * 1024; // 20 MB

/** A tab whose document exceeds this many characters is treated as "very
 * large": eligible for in-place unload / reload (L3) and no undo history. */
export const UNLOAD_BIG_CHARS = 40_000_000; // ≈ 55+ MB of text

/** Maximum number of "very large" clean tabs kept loaded at once (L3). */
export const KEEP_LOADED_BIG = 4;

/** Startup / session restore skips files above this size (L1). */
export const SESSION_SKIP_BYTES = 64 * 1024 * 1024; // 64 MB
