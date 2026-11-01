# ADR 0341: Local Dictation returns with on-device transcript cleanup

- Status: Accepted (implemented; packaged-build verification pending)
- Date: 2026-11-01
- Deciders: PI-Desktop maintainers
- Related: ADR 0281 (host speech capability), ADR 0291 (no speech settings
  surface), ADR 0313 / 0315 / 0316 (Live Voice),
  `docs/spec/03-runtime/23-local-dictation.md`,
  `docs/spec/03-runtime/live-voice.md`,
  `docs/project/voice-dictation-text-cleanup-design.md`
- Supersedes: the "legacy Dictation settings and its Composer entry are hidden"
  decision previously recorded in `docs/spec/03-runtime/live-voice.md` and
  `docs/spec/04-ux/06-settings-ia.md`. Host Speech stays hidden per ADR 0291.

## Context

The local Dictation capability (`packages/voice-runtime` plus
`apps/desktop/electron/main/voice-service.ts`) shipped without a way to reach
it. The Composer had no microphone control, the state listener existed only in
development builds, Settings → Voice exposed Live Voice alone, and
`docs/spec/04-ux/08-component-spec.md` stated "No voice-to-draft input".

Hidden was also non-functional. The code could not have produced a transcript
for a user:

| Defect | Effect |
| --- | --- |
| Catalog filenames used whisper.cpp `ggml-*.bin` names | Those files do not exist on Hugging Face; transcribe-cpp loads `*.gguf` |
| Every catalog entry had `sha256: ""` | Downloads were unverified |
| The downloader treated `@huggingface/hub`'s `Blob` as a `Response` | Download failed |
| The controller could not leave `done` | A second recording never started |
| Cancel during transcription surfaced as an error | A normal user action looked like a failure |
| The streaming path misused transcribe-cpp 0.2's async API | Streaming could not work |

Separately, raw speech is not draft-quality text. A dictated Chinese request
arrives with 嗯/呃 hesitations, standalone 那个/就是说, stutters, repeated
connectors and spoken self-corrections ("改成5秒，不对，改成10秒"). Inserting
that verbatim moves the editing work to the user.

No shipping local model does Chinese ASR and disfluency removal in one pass,
and the published dictation-cleanup models are English-only, so cleanup is a
second stage rather than a model swap.

## Decision

### 1. Dictation is a user-visible feature again

A Composer microphone control appears when local tools are allowed and
`settings.voice.enabled` is true. It records in Electron Main through
PvRecorder, transcribes locally with transcribe-cpp 0.2.2, cleans the text, and
inserts the result into the Composer draft. It never auto-sends. "Restore
original" swaps the inserted text back to the recognizer output while the rest
of the draft stays as the user left it.

Settings → Voice (label "Voice") shows a Dictation card above the unchanged
Live Voice card: enable, microphone, languages, Chinese variant, transcription
model download / delete / select, cleanup mode, cleanup model. Live Voice keeps
its developer-mode and development-build gate; Dictation has neither. Host
Speech stays absent from Settings (ADR 0291).

### 2. Settings shape, unchanged storage contract

```
AppSettings.voice = {
  enabled, deviceId, languages, chineseVariant, modelId,
  cleanupMode?: "off" | "rules" | "llm"
}
```

An absent `cleanupMode` reads as `"rules"`. host-core keeps storing the value as
opaque JSON: no schema version bump, and every existing field keeps its
meaning. Electron Main validates renderer-provided settings and model ids at the
IPC boundary (`packages/voice-runtime/src/settings.ts`), so a malformed patch
cannot reach the controller or the native recognizer.

### 3. No new IPC channels

The existing `pi-harbor/voice/*` surface carries the feature. Three payloads
grow:

- `VoiceState.errorCode`: `no-model`, `model-not-downloaded`,
  `microphone-denied`, `failed`. The renderer localizes the code; `error` stays
  diagnostic.
- `VoiceResult`: adds `rawText` (recognizer output, for "restore original") and
  `cleanup { mode, applied, fallback? }` with `fallback` in `model-missing`,
  `too-long`, `timeout`, `rejected`, `failed`.
- `ModelInfo.kind`: `transcription` or `cleanup`, so one catalog serves both
  stages.

A recording can start again from `done` and from `error`.

### 4. Recognition

One selected language pins the recognizer. Several selected languages let it
detect, and when the detected language is not among the selected ones the clip
is re-run pinned to the first selected language. ITN and punctuation are
requested when the model reports support. A clip under 0.3 s transcribes to
empty text and inserts nothing.

### 5. Cleanup is rules first, model second

`"rules"` is the default. It deterministically removes only unambiguous
fillers: Chinese 嗯/呃 hesitations; 额/唔/哦/噢/诶/欸/哎 and
那个/这个/就是说/怎么说呢/你知道吗 when standalone between pauses; 那个 directly
before a personal pronoun at clause start; duplicated connectors (那个那个,
然后然后…); stutters (我我我, 我，我想); English `um`/`uh`/`erm`/`hmm`/`ah`,
comma-bounded "you know", tripled words and doubled function words, with the
English rules active only when English is the detected or selected language.
Ambiguous words (这个, 然后, 就是, "like", "I mean") are left alone.

`"llm"` runs the rules, then a bundled local model removes self-corrections and
repetition: Qwen3-1.7B Q4_K_M GGUF (`unsloth/Qwen3-1.7B-GGUF`, 1,107,409,472
bytes, SHA-256 pinned) through node-llama-cpp 3.22.2 with prebuilt binaries
only (`build: "never"`), greedy decoding, thinking discouraged, context 2048.

Guards keep the model from inventing content. Code, URLs, paths, file names,
identifiers, numbers and Latin terms inside Chinese are masked as `⟦n⟧`
duplicated or invented, when a placeholder is dropped without a self-correction
cue (不对, 算了, "actually", "scratch that"…), when its comparable units are
not a deletion-only subsequence of the masked input, when a negation outside a
self-correction cue is dropped, when too little content remains, or when think
tags appear. Punctuation and spacing are ignored by the subsequence comparison;
additions, replacements and reordering are forbidden. The timeout is 15 s;
inputs over 500 characters skip the model. Every fallback keeps the rules text
and reports why.

### 6. The cleanup model runs in a dedicated utility process

node-llama-cpp 3.22.2 and transcribe-cpp 0.2.2 each ship their own ggml build
under the same dylib install name (`@rpath/libggml-base.dylib`) at different
versions. Loading both in one process crashed with SIGSEGV (exit 139) on macOS
arm64 in a real-device probe.

So the recognizer stays in Electron Main and the cleanup model runs in an
Electron `utilityProcess`: `out/main/voice-polisher-worker.js`, built from
`packages/voice-runtime/src/cleanup/polisher-worker.ts`. Main talks to it
through `ProcessPolisher` over an id-matched request/response protocol
(`packages/voice-runtime/src/cleanup/polisher-protocol.ts`: `prepare`,
`polish`, `abort`; results are ok or error).

### 7. Lifecycle

The recognizer loads lazily in Main and unloads after ten idle minutes. The
cleanup worker spawns lazily on first `llm` use and prewarms when a recording
starts in `llm` mode. It is killed on the ten-minute idle unload, when the
cleanup mode switches away from `llm`, before deleting the cleanup model, and on
app quit. A worker crash rejects the in-flight request, the pipeline falls back
to the rule-based text with `fallback: "failed"`, and the next request spawns a
fresh worker. Cancellation is forwarded to the worker and stops generation.

Audio and text never leave the device. Model downloads are the only network use.

### 8. Models, downloads, integrity

Files download from `https://huggingface.co/<repo>/resolve/main/<file>` through
Electron `net.fetch`, so the app's network-proxy settings apply. Bytes land in
`<dataDir>/voice-models/<id>/<file>.part`, are SHA-256 verified against the
pinned catalog digest, and are renamed into place only after the digest matches.
`@huggingface/hub` was removed.

| Catalog id | File | Bytes | Note |
| --- | --- | --- | --- |
| `sensevoice-small` | `SenseVoiceSmall-Q8_0.gguf` | 252,684,608 | Recommended for zh / en / yue / ja / ko |
| `fun-asr-nano` | `Fun-ASR-Nano-2512-Q8_0.gguf` | 891,271,072 | Chinese-focused, larger and slower |
| `whisper-large-v3-turbo` | `whisper-large-v3-turbo-Q8_0.gguf` | 886,381,728 | Recommended for other languages |
| `whisper-medium` | `whisper-medium-Q8_0.gguf` | 831,538,144 | — |
| `whisper-small` | `whisper-small-Q8_0.gguf` | 269,751,136 | — |
| `qwen3-1.7b` | `Qwen3-1.7B-Q4_K_M.gguf` | 1,107,409,472 | Cleanup model |

SenseVoice Small, Fun-ASR-Nano and Whisper Small were loaded and transcribed on
an Apple M5 with transcribe-cpp 0.2.2. Whisper Medium and Large come from the
same converter as Whisper Small.

### 9. Packaging

node-llama-cpp is a desktop dependency, external to the Main bundle, with its
native files unpacked from asar. koffi (used by transcribe-cpp) dlopens the
native library by path and cannot read inside `app.asar`, so Main sets
`TRANSCRIBE_LIBRARY` to the unpacked library in packaged builds
(`apps/desktop/electron/main/voice-native-paths.ts`). `asarUnpack` covers
koffi, `@koromix`, `@transcribe-cpp`, node-llama-cpp bins and
`@node-llama-cpp`.

## Consequences

- A user can dictate into the Composer again, with the draft as the review
  surface. Nothing is sent without an explicit send.
- `rawText` travels with every result, so "restore original" is a local swap
  rather than a second transcription.
- The default `"rules"` mode is deterministic, costs nothing measurable, and
  needs no download beyond the recognizer.
- `"llm"` mode costs a ~1.1 GB download and about 1.7 GB of worker RSS while
  loaded (Main stays near 0.3 GB). Users who do not choose it never pay it.
- The utility process keeps the two conflicting ggml builds apart, at the cost
  of one more process, an IPC hop, and a cold first `prepare` of about 9.8 s
  (warm respawn 1.7 s).
- A cleanup-worker crash degrades to rule-based text instead of failing the
  dictation, and cannot take the app down with it.
- Masking protects spans from invention but also freezes them: an ASR mistake
  inside a protected span (for example "ken" for "token") is not corrected.
- Deletion-only cleanup cannot perform substitutions or reordering. Corrections
  that need either operation intentionally fall back to the rule-based text;
  an unchanged correction can also remain a safe no-op.
- Settings stay backward compatible in both directions: an old build reading new
  values ignores `cleanupMode`, and a new build reading old values defaults to
  `"rules"`.
- No packaged build has been run. Native unpacking and `TRANSCRIBE_LIBRARY`
  resolution in a signed package remain unverified; this is a residual risk.

## Alternatives

### In-process node-llama-cpp in Electron Main (rejected)

The simplest wiring: load the cleanup model in the same process as the
recognizer, no worker, no protocol, no second RSS figure. Rejected because it
crashes. node-llama-cpp 3.22.2 and transcribe-cpp 0.2.2 ship different ggml
versions under the same `@rpath/libggml-base.dylib` install name, and loading
both in one process aborted with SIGSEGV (exit 139) on macOS arm64 in a
real-device probe. A native crash there would also take the whole app down, not
just cleanup.

### A user-run local OpenAI-compatible server (Ollama, LM Studio)

No new native dependency and no bundled weights: cleanup would call a local HTTP
endpoint the user already runs. Rejected as the default because it moves setup
onto the user — install a server, pull a model, keep it running — for a feature
that must work the first time someone enables it.

### Reusing the configured chat provider

Zero setup and no download: send the transcript to the model the user already
configured. Rejected because it sends unreviewed dictation off-device. Dictation
captures whatever the microphone heard, and the user has not yet read it.

### Bundled node-llama-cpp in a utility process (chosen)

Fully local, zero setup, and the only option that keeps unreviewed speech on the
device without asking the user to run a server. The costs are a native
dependency, a ~1.1 GB download, about 1.7 GB of memory while loaded, and one
extra process to supervise.

## Validation

Measured on this machine (MacBook Pro M5, macOS 27, Metal) with macOS TTS clips:

| Measurement | Result |
| --- | --- |
| SenseVoice Small Q8_0 load | 0.3–0.45 s |
| 6–8 s clip transcription | 65–110 ms |
| 23 s clip transcription | 425 ms |
| 45 s clip | Not truncated |
| Cleanup worker first `prepare` (spawn + load, cold) | 9.8 s |
| Cleanup worker warm respawn | 1.7 s |
| Polish per utterance | 250–1250 ms |
| Worker RSS / Main RSS | ~1.7 GB / ~0.3 GB |
| Abort rejection | ~50 ms, next request runs normally |
| SIGKILLed worker | Rejects in ~60 ms, next call respawns |

Quality with the real model and the guard on: 9 of 11 probe inputs were accepted.
A self-correction resolved ("把超时改成5秒，不对，改成10秒，然后重试3次" became
"把超时改成10秒，然后重试3次"), a repeated clause was removed, a question stayed
a question, and protected spans were restored verbatim (`package.json`, "voice
service", "PNPM test", numbers). The two rejected outputs swapped the
staging/production targets and replaced `N` with `and`; both correctly fell back
to the rule-based text as `not-a-deletion`.

The real downloader fetched `sensevoice-small` (252,684,608 bytes) end to end
through a proxy and the SHA-256 matched the catalog.

`packages/voice-runtime` vitest suites cover cleanup fillers, the guard, the
pipeline and `ProcessPolisher`, plus the downloader, settings validation, the
catalog and the controller. They replace
`apps/desktop/test/voice-model-download.test.mjs` and its hub stubs, which were
deleted together with the `@huggingface/hub` dependency.
