/** Type declarations for scripts/build-app.mjs (kept alongside so `src/tests/app-assembly.test.ts` typechecks). */

export interface AppManifestModule {
  file: string;
  module: string;
  from: number;
  to: number;
}

export interface AppManifest {
  output: string;
  description: string;
  modules: AppManifestModule[];
}

export function readManifest(): AppManifest;

/** Concatenate the ordered manifest fragments into the single-file SPA bundle. */
export function buildApp(): string;

/** Whether public/app.js already matches the assembled bundle. */
export function isCurrentAppFresh(): boolean;
