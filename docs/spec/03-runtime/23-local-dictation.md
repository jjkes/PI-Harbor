# 23. Local Dictation

> Source of truth: `packages/voice-runtime/src/`,
> `apps/desktop/electron/main/voice-service.ts`.
> ADR: [0341-local-dictation-with-transcript-cleanup](../../adr/0341-local-dictation-with-transcript-cleanup.md).

## 1. Scope

Dictation turns speech into Composer draft text on the device. Electron Main
captures the microphone with PvRecorder, transcribes with transcribe-cpp
0.2.2, cleans the transcript, and the renderer inserts the result into the
draft. It never sends the draft.

Dictation is user-visible when local tools are allowed and
`settings.voice.enabled` is true: the Composer shows one microphone control
and Settings → Voice shows a Dictation card. It is not developer-gated and
not build-gated.

Live Voice ([live-voice.md](live-voice.md)) and Host Speech
([20-speech.md](20-speech.md)) are separate capabilities. Live Voice keeps its
developer-mode and development-build gate; Host Speech stays absent from
Settings (ADR 0291).

## 2. Pipeline

```
microphone (PvRecorder, Electron Main)
  → PCM
  → transcribe-cpp recognizer       (Main; language pinning, ITN, punctuation)
  → OpenCC Chinese variant conversion
  → cleanup                         (off | rules | llm)
  → renderer inserts into the Composer draft
```

Every step except insertion runs in Electron Main, except the `llm` cleanup
model, which runs in its own utility process (§6). The result carries two
texts: `text` for insertion and `rawText` as the recognizer produced it. The
user can swap inserted text back to `rawText` ("restore original") with the
rest of the draft untouched. Nothing is auto-sent.

While listening, Main also transcribes the accumulated audio about every
0.8 s, once at least 0.6 s has been captured, and publishes the latest text as
`partialText` on `VoiceState`. This preview uses rules cleanup only, even in
`llm` mode, and runs one pass at a time. The final stop pass waits for an
in-flight preview, then replaces it with the authoritative cleaned result.
A preview failure is logged as a diagnostic and never ends the recording.
The Composer replaces the preview tail without stealing focus and preserves
text the user types after it. The control remains one microphone/stop button:
no recording timer or cancel action is shown.

Settings → Shortcuts exposes **Hold to Dictate** (`dictationPushToTalk`,
default `Mod+T`, shown as Command+T on macOS). Pressing the binding starts
dictation and releasing it stops and transcribes; key repeat is ignored.
Window blur or hiding the document releases the key safely. The action is
active only on the chat page with Dictation enabled, and follows the normal
shortcut rebind, disable, and conflict rules.

## 3. Capture and recognition

One selected language pins the recognizer. Several selected languages let the
recognizer detect, and when the detected language is not among the selected
ones the clip is transcribed again pinned to the first selected language.

Inverse text normalization (`itn`) and punctuation (`pnc`) are requested when
the loaded model reports support for them.

A clip shorter than 0.3 s transcribes to empty text, and nothing is inserted.

Live Voice and Dictation share the Main-process microphone lease; each end
releases it.

## 4. Settings

`AppSettings.voice`:

| Field | Meaning |
| --- | --- |
| `enabled` | Dictation control is offered |
| `deviceId` | Microphone; `null` is the system default |
| `languages` | Languages the user dictates in, for example `["zh", "en"]` |
| `chineseVariant` | `simplified`, `traditional-taiwan`, `traditional-hong-kong` |
| `modelId` | Selected transcription model catalog id |
| `cleanupMode` | `off`, `rules` (default when absent), `llm` |

host-core stores the value as opaque JSON. There is no storage schema version
change, and previously stored fields keep their meaning. Electron Main
validates renderer-provided settings patches and model ids at the IPC boundary
(`packages/voice-runtime/src/settings.ts`): unknown keys and invalid values are
dropped instead of reaching the controller or the native recognizer.

## 5. State and IPC contract

No channel was added for this feature. The existing surface:

| Channel | Purpose |
| --- | --- |
| `pi-harbor/voice/start` | Start a recording with validated settings |
| `pi-harbor/voice/stop` | Stop recording and transcribe |
| `pi-harbor/voice/cancel` | Cancel recording or transcription |
| `pi-harbor/voice/getState` | Current `VoiceState` |
| `pi-harbor/voice/getDevices` | Input devices |
| `pi-harbor/voice/getModels` | Catalog entries with per-model status |
| `pi-harbor/voice/downloadModel` | Download one catalog model |
| `pi-harbor/voice/deleteModel` | Delete one downloaded model |
| `pi-harbor/voice/updateSettings` | Apply a validated settings patch |
| `pi-harbor/voice/checkPermission` | Microphone permission state |
| `pi-harbor/voice/requestPermission` | Request microphone permission |
| `pi-harbor/voice/event/stateChanged` | `VoiceState` push |
| `pi-harbor/voice/event/modelProgress` | Download progress push |

Phases: `idle`, `preparing`, `ready`, `starting`, `listening`,
`transcribing`, `done`, `error`, `cancelling`. A recording can start again
from `done` and from `error`. Cancel during transcription ends in a terminal
non-error phase, not in `error`.

`VoiceState` carries `phase`, `durationSeconds`, `volumeLevel`, an optional
replaceable `partialText` while `listening`, an optional diagnostic `error`,
an optional `errorCode`, and `result` when `phase` is `done`.

`VoiceResult`:

```
{
  text,            // inserted text, after cleanup
  rawText,         // recognizer output, for "restore original"
  cleanup: { mode, applied, fallback? },
  speechSeconds,
  transcribeSeconds,
  language
}
```

`ModelInfo.kind` is `transcription` or `cleanup`, so one catalog serves the
recognizer and the cleanup model.

## 6. Cleanup

`packages/voice-runtime/src/cleanup/`.

### 6.1 `rules` (default)

Deterministic removal of unambiguous fillers only:

- Chinese 嗯/呃 hesitations.
- 额/唔/哦/噢/诶/欸/哎 and 那个/这个/就是说/怎么说呢/你知道吗 only when
  standalone between pauses.
- 那个 directly before a personal pronoun at clause start.
- Duplicated connectors (那个那个, 然后然后…).
- Stutters (我我我, 我，我想).
- English `um`/`uh`/`erm`/`hmm`/`ah`, comma-bounded "you know", tripled words,
  doubled function words. English rules apply only when English is the
  detected or selected language.

Ambiguous words (这个, 然后, 就是, "like", "I mean") are left alone: removing
them can change what the speaker asked for.

### 6.2 `llm`

Runs the rules, then a bundled local model removes self-corrections and
repetition: Qwen3-1.7B Q4_K_M GGUF through node-llama-cpp 3.22.2, prebuilt
binaries only (`build: "never"`), greedy decoding, thinking discouraged,
context 2048.

The model does **not** run in Electron Main. node-llama-cpp 3.22.2 and
transcribe-cpp 0.2.2 each ship their own ggml build under the same dylib
install name (`@rpath/libggml-base.dylib`) at different versions, and loading
both in one process crashed with SIGSEGV (exit 139) on macOS arm64. The
recognizer stays in Main; the cleanup model runs in an Electron
`utilityProcess` (`out/main/voice-polisher-worker.js`, built from
`packages/voice-runtime/src/cleanup/polisher-worker.ts`). Main drives it
through `ProcessPolisher` over an id-matched request/response protocol
(`packages/voice-runtime/src/cleanup/polisher-protocol.ts`): `prepare`,
`polish`, `abort`, with ok or error results.

### 6.3 Guards

Code, URLs, paths, file names, identifiers, numbers and Latin terms inside
Chinese are masked as `⟦n⟧` placeholders and restored after the model returns.
Model output is rejected when:

- a placeholder is duplicated or invented,
- a placeholder is dropped without a self-correction cue (不对, 算了,
  "actually", "scratch that"…),
- its comparable units are not a deletion-only subsequence of the masked input
  (additions, replacements and reordering are forbidden; punctuation and
  spacing are ignored),
- it drops a negation outside a self-correction cue,
- too little content remains, or think tags appear.

Consequently, a correction that requires replacing or reordering words falls
back to the rule-based text rather than risking a semantic rewrite.

Masking also freezes those spans: a recognition mistake inside a protected
span (for example "ken" for "token") is not corrected.

### 6.4 Fallbacks

Any problem keeps the rule-based text and reports why in `cleanup.fallback`:

| Fallback | Cause |
| --- | --- |
| `model-missing` | The cleanup model is not available |
| `too-long` | Input over 500 characters; the model is skipped |
| `timeout` | Generation exceeded 15 s |
| `rejected` | A guard refused the output |
| `failed` | The worker or the model errored, including a worker crash |

Cleanup never turns into a dictation error.

## 7. Models, downloads, integrity

Downloads use Electron `net.fetch`, so the app's network-proxy settings apply.
The pinned file is fetched from
`https://huggingface.co/<repo>/resolve/main/<file>`. A host that cannot serve it
— a reset connection, no response within 30 seconds, or a 5xx/408/429 — falls
through to `https://hf-mirror.com` on the same path; a definitive answer such as
404 ends the download instead of repeating it. `PI_VOICE_MODEL_HUB` replaces the
order with a comma-separated list of origins.

Bytes land in `<dataDir>/voice-models/<id>/<file>.part`, are SHA-256 verified
against the catalog digest, and are renamed into place only on a match. A digest
mismatch discards the partial file; every other failure keeps it, and the next
attempt continues with a `Range` request from its current length (a `200` or a
rejected range restarts from zero). A cancelled download is resumable too. Each
failure records its message on the model state, which Settings shows beside the
retry action. `@huggingface/hub` is not a dependency.

| id | kind | File | Bytes |
| --- | --- | --- | --- |
| `sensevoice-small` | transcription | `SenseVoiceSmall-Q8_0.gguf` | 252,684,608 |

When the built-in sources cannot be reached, the model row offers a **Manual
download** link (the same pinned URL) and an **Import file** action. Import
opens a file picker, then verifies the chosen file against the catalog's pinned
size and SHA-256 before installing it as the model; a mismatch is rejected and
the reason is shown in the row. An import unloads the model first and clears
any interrupted download of it.

| `fun-asr-nano` | transcription | `Fun-ASR-Nano-2512-Q8_0.gguf` | 891,271,072 |
| `whisper-large-v3-turbo` | transcription | `whisper-large-v3-turbo-Q8_0.gguf` | 886,381,728 |
| `whisper-medium` | transcription | `whisper-medium-Q8_0.gguf` | 831,538,144 |
| `whisper-small` | transcription | `whisper-small-Q8_0.gguf` | 269,751,136 |
| `qwen3-1.7b` | cleanup | `Qwen3-1.7B-Q4_K_M.gguf` | 1,107,409,472 |
`sensevoice-small` is recommended for zh / en / yue / ja / ko and
`whisper-large-v3-turbo` for other languages. SenseVoice Small, Fun-ASR-Nano
and Whisper Small were loaded and transcribed on an Apple M5 with
transcribe-cpp 0.2.2; Whisper Medium and Large come from the same converter as
Whisper Small.

In packaged builds koffi (used by transcribe-cpp) dlopens the native library by
path and cannot read inside `app.asar`, so Main points `TRANSCRIBE_LIBRARY` at
the unpacked library (`apps/desktop/electron/main/voice-native-paths.ts`).
`asarUnpack` covers koffi, `@koromix`, `@transcribe-cpp`, node-llama-cpp bins
and `@node-llama-cpp`.

## 8. Lifecycle

The recognizer loads lazily in Main and unloads after ten minutes in a
terminal phase without a new recording. Starting a recording cancels a pending
unload; the next recording reloads from the on-disk cache.

The cleanup worker:

| Event | Effect |
| --- | --- |
| First `llm` cleanup | Spawn and `prepare` |
| Recording starts in `llm` mode | Prewarm |
| Ten-minute idle unload | Kill |
| Cleanup mode leaves `llm` | Kill |
| Before deleting the cleanup model | Kill |
| App quit | Kill |
| Worker crash | Reject the in-flight request, fall back to rules text (`failed`), spawn fresh on the next request |
| Cancellation | Forwarded to the worker; generation stops |

Measured on a MacBook Pro M5 (macOS 27, Metal) with macOS TTS clips:
SenseVoice Small Q8_0 loads in 0.3–0.45 s and transcribes a 6–8 s clip in
65–110 ms and a 23 s clip in 425 ms; a 45 s clip was not truncated. The
cleanup worker's first `prepare` (spawn plus cold load) took 9.8 s, a warm
respawn 1.7 s, and a polish 250–1250 ms per utterance. Worker RSS was about
1.7 GB with Main near 0.3 GB. An abort rejected in about 50 ms and the next
request ran normally; a SIGKILLed worker rejected in about 60 ms and the next
call respawned it.

## 9. Errors

`VoiceState.errorCode` is the stable category; the renderer localizes it and
`error` stays diagnostic.

| Code | Meaning |
| --- | --- |
| `no-model` | No transcription model is selected |
| `model-not-downloaded` | The selected model is not on disk |
| `microphone-denied` | Microphone permission was refused |
| `failed` | Any other failure, with the diagnostic in `error` |

A cleanup problem is never an error here: it degrades through
`cleanup.fallback` (§6.4).

## 10. Privacy

Audio and transcripts stay on the device. Nothing is persisted beyond the
Composer draft the user keeps, and no transcript is sent to a provider. Model
downloads are the only network traffic this feature creates.
