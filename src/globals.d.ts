/**
 * Build-time constants injected by esbuild define in build-exe.mjs.
 *
 * Only the exe build defines these. The npm build reads the equivalent facts
 * from build/build-info.json, written by scripts/stamp-build.mjs.
 */
declare const CDP_CLI_VERSION: string | undefined;
declare const CDP_CLI_EXE_MODE: boolean | undefined;
declare const CDP_CLI_BUILD: string | undefined;
declare const CDP_CLI_COMMIT: string | undefined;
declare const CDP_CLI_DIRTY: boolean | undefined;
