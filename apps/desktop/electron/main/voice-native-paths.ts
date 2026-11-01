/**
 * Packaged-build path fix for transcribe-cpp.
 *
 * transcribe-cpp resolves its platform library from node_modules and opens it
 * with koffi's native dlopen. In a packaged app that path points inside
 * app.asar, which dlopen cannot read. electron-builder unpacks the library
 * (`asarUnpack: node_modules/@transcribe-cpp/**`), so hand transcribe-cpp the
 * unpacked copy through its TRANSCRIBE_LIBRARY override. Development builds
 * and an explicit TRANSCRIBE_LIBRARY are left alone.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const LIBRARY_NAMES = [
  "libtranscribe.dylib",
  "libtranscribe.so",
  "transcribe.dll",
  "libtranscribe.dll",
];

export interface LibraryLookupFs {
  existsSync(target: string): boolean;
  readdirSync(target: string): string[];
}

const nodeFs: LibraryLookupFs = {
  existsSync,
  readdirSync: (target) => readdirSync(target),
};

/** The unpacked transcribe-cpp library next to its contract.json, if any. */
export function findUnpackedTranscribeLibrary(
  resourcesPath: string,
  fs: LibraryLookupFs = nodeFs,
): string | null {
  const scope = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@transcribe-cpp");
  if (!fs.existsSync(scope)) return null;
  for (const entry of [...fs.readdirSync(scope)].sort()) {
    const dir = path.join(scope, entry);
    if (!fs.existsSync(path.join(dir, "contract.json"))) continue;
    for (const name of LIBRARY_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Packaged builds only; an explicit TRANSCRIBE_LIBRARY always wins. */
export function configurePackagedTranscribeLibrary(
  isPackaged: boolean,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
  fs: LibraryLookupFs = nodeFs,
): void {
  if (!isPackaged || env.TRANSCRIBE_LIBRARY) return;
  const library = findUnpackedTranscribeLibrary(resourcesPath, fs);
  if (library) env.TRANSCRIBE_LIBRARY = library;
}
