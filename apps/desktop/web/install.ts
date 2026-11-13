/**
 * Imported first by `main.tsx`, so the fake preload bridge exists before any
 * renderer module is evaluated. `src/lib/api.ts` reads `window.piDesktop` when a
 * channel is called, but the app store builds its runtimes at import time — the
 * same ordering the product entry point uses for its web-access bridge.
 */
import { installHarnessBridge } from "./mock-bridge";

installHarnessBridge();
