# Dictation Text Cleanup — Model Recommendation and Design

Status: proposal (no code changed)
Scope: local Dictation only (`packages/voice-runtime` + `VoiceService`).
Live Voice (`docs/spec/03-runtime/live-voice.md`) and Host Speech
(`docs/spec/03-runtime/20-speech.md`) are separate capabilities and are out
of scope.

Goal: raw speech should reach the Composer as text a reader would type —
filler words removed, self-corrections resolved, rambling tightened — without
changing what the speaker actually asked for.

---

## 1. Current state (verified in this repo)

| Concern | Today |
|---|---|
| Engine | `transcribe-cpp` 0.2.2 (ggml/GGUF), native `@transcribe-cpp/darwin-arm64-metal`, `header_hash 7df72bf9e667b8c2` |
| Orchestration | `VoiceController` → `TranscriptionEngine` → `ModelManager`, driven by `VoiceService` in Electron Main |
| Model source | Static inline catalog: `whisper-large-v3-turbo` (recommended), `whisper-small`, `whisper-medium`, `sensevoice-small` |
| Post-processing | OpenCC Chinese variant conversion only (`chinese.ts`) |
| Local LLM runtime | None. No llama.cpp / MLX / Ollama dependency anywhere in the workspace |
| Settings | `AppSettings.voice = { enabled, deviceId, languages, chineseVariant, modelId }` |

Two defects in the current catalog block any model change and must be fixed
first:

- Every entry has `sha256: ""`, so downloads are unverified.
- Filenames use whisper.cpp `ggml-*.bin` style while transcribe.cpp loads
  `*.gguf`; `handy-computer/SenseVoiceSmall-GGUF` and its
  `sizeBytes: 466_000_000` (near-identical to the whisper-small figure) look
  like placeholders, and the file's own comment says the catalog "would be
  loaded from catalog/catalog.json" in a real implementation.

`TranscriptionEngine.transcribe()` passes only `{ language }` to
`model.transcribe()`. The engine already accepts `pnc` (punctuation and
capitalization) and `itn` (inverse text normalization) run options with
`model.supports("pnc")` / `model.supports("itn")` probing. Both are unused
today — free output quality that needs no new model.

---

## 2. Model recommendation

### 2.1 The honest constraint

No shipping local model does Chinese ASR **and** disfluency removal in one
pass. The closest published work is FormalASR (arXiv 2605.19266), which
fine-tunes Qwen3-ASR at 0.6B and 1.7B for spoken-Chinese-to-formal-text and
reports up to 37.4% relative CER reduction over verbatim baselines on
WenetSpeech-Formal and Speechio-Formal. No released GGUF weights were found,
so it cannot be adopted now.

The dictation-cleanup model category does exist, but the verified members are
English-only: `superwhisper/s1-mini` (Qwen3-0.6B fine-tune, 462 MB Q4_K_M,
"release v1 covers English only"), `spokenly/cleanup-1`, `enconvo/tidy-1-mlx`,
`Quobi/Quill`.

Conclusion: for a Chinese-speaking user this is a **two-stage pipeline**, and
a deterministic rule layer should absorb most of the filler-word work before
any LLM is involved.

### 2.2 Stage 1 — ASR

| Candidate | Why | Risk |
|---|---|---|
| **Fun-ASR-Nano** (primary) | Frozen SenseVoiceEncoderSmall + 2-layer adaptor + bundled Qwen3-0.6B, ~800M params; Chinese/dialect/accent focus; transcribe.cpp ships a model doc for it | Arch support in the **installed** 0.2.2 native lib is unverified |
| **Qwen3-ASR-0.6B** (alternate) | HF card: language ID + ASR for 30 languages and 22 Chinese dialects; GGUF conversions exist (`memoravox`, `unslothai`); transcribe.cpp model doc exists | Same arch-support question; audio-LLM decode is slower than CTC-style models |
| **SenseVoice Small** | Secondary benchmarks recommend it for zh/ja/ko/yue; smallest of the three | Current catalog entry is a placeholder; real repo and filename must be established |
| **whisper-small / large-v3-turbo** | Already wired and working; safe fallback | turbo pins ~1.5 GiB of main-process memory once loaded (see the `MODEL_IDLE_UNLOAD_MS` comment and issue #1528); verbatim output keeps every filler |

The installed 0.2.2 TypeScript bindings expose family extensions only for
`whisper`, `moonshine`, `parakeet`, `parakeet_buffered`, `voxtral`, and
`sortformer`. A family extension is not the same as architecture support — a
model can load without per-family options — but `TRANSCRIBE_ERR_UNSUPPORTED_ARCH`
exists in the ABI, so an unsupported arch fails loudly at load. **Phase 0 must
load each candidate GGUF once and record the result.** Do not ship a catalog
entry for a model that has not been loaded on this machine.

### 2.3 Stage 2 — cleanup

- **Chinese + English: `Qwen3-1.7B-Instruct` GGUF Q4_K_M** (~1.1 GB) as the
  default; `Qwen3-0.6B` for low-resource machines, accepting weaker
  instruction-following.
- **English-only users: `superwhisper/s1-mini-GGUF` Q4_K_M (462 MB)** is
  purpose-built and cheaper than a general LLM, steered by a control line
  rather than a prompt.

transcribe.cpp cannot serve this stage: it is STT-only and exposes no
free-form text generation.

---

## 3. Design

### 3.1 Pipeline

```
PCM ─► ASR (transcribe-cpp)
        │  pnc / itn when model.supports() says yes
        ▼
      raw text ──► OpenCC variant conversion (existing)
        │
        ▼
      Layer A: deterministic filler removal      (pure, ~0 ms, always safe)
        │
        ▼
      Layer B: optional local LLM polish         (opt-in, guarded, fallible)
        │
        ▼
      Composer (user reviews; raw text recoverable)
```

Raw text is retained alongside the cleaned text for the lifetime of the
result so the UI can offer a revert. Nothing is auto-sent.

### 3.2 Layer A — rules (covers "去掉语气词")

New pure module `packages/voice-runtime/src/text-cleanup.ts`, no I/O, no
model, fully unit-testable.

Removes:

- Standalone hesitation tokens: `嗯 呃 啊 额 唉 诶 欸 哦` / `um uh erm ah`.
- Immediate token repeats from stutter: `嗯嗯嗯`, `这个这个`, `the the`.
- Conversational tails when they form the whole clause: `对吧`, `你知道吧`,
  `是不是`, `you know`, `I mean`, `like` (English `like` only when fenced by
  commas).

Deliberately **not** removed by rules:

- `那个` / `这个` / `就是说` / `然后` in general position. They are legitimate
  demonstratives and connectives in Chinese; stripping them unconditionally
  corrupts meaning. They are only dropped when standalone between pause
  punctuation or immediately repeated.
- Self-corrections and redundant description. Rules cannot tell which value
  the speaker landed on. That is Layer B's job.

Invariants: idempotent, never touches protected spans (§3.3), never produces
empty output from non-empty input (falls back to the input).

### 3.3 Layer B — optional LLM polish (covers "整理无用描述")

Dictated text becomes a prompt to a coding agent, so an unguarded rewrite can
silently corrupt an instruction. Three mandatory guards:

1. **Mask then restore.** Before the rewrite, replace protected spans with
   opaque placeholders: file paths, URLs, code identifiers (`camelCase`,
   `snake_case`, `dotted.paths`), backticked spans, version strings, numbers.
   Restore after. The LLM never sees a token it could "improve".
2. **Accept or reject, never trust.** Discard the rewrite and keep Layer A's
   output when any of these trip: output/input length ratio outside
   `[0.5, 1.2]`; any protected placeholder missing, duplicated, or altered;
   output contains added interrogatives or instructions absent from the input;
   generation exceeds its deadline (suggest 3 s) or the request is cancelled.
3. **Reviewable and reversible.** Result lands in the Composer, not in a sent
   message. One click restores the raw transcript.

Prompt contract: rewrite only, no answering, no summarizing, no translating,
preserve language and all concrete values, output text only.

**Runtime decision (needs the user's call):**

| Option | Cost | Trade-off |
|---|---|---|
| **B1 — localhost OpenAI-compatible server** (Ollama / LM Studio), reusing the existing `openai_compatible` plumbing | No new native dependency, no bundle growth | User must install and run a server; feature silently unavailable otherwise |
| B2 — bundle `node-llama-cpp` | Fully self-contained | New native dependency, per-platform builds, significant bundle growth, a second GGUF runtime next to transcribe.cpp |
| B3 — reuse the user's cloud chat provider | Zero infrastructure | **Rejected.** Sends voice content off-device and breaks Dictation's local-only privacy property |

Recommendation: **B1 first.** It is reversible, adds no native surface, and
proves demand before B2 is considered.

### 3.4 Settings

Backward-compatible optional field on `VoiceInputSettings`
(`packages/shared/src/types/settings.ts`); absent means current behavior:

```ts
cleanup?: {
  mode: "off" | "rules" | "rules+llm";
  llm?: { endpoint: string; modelId: string; timeoutMs?: number };
};
```

No credentials are stored here, matching the Live Voice settings rule.

**Default — decision required.** `"off"` is strictly compatible with § 3 of
`AGENTS.md`. `"rules"` is what the feature is for, and its output is
recoverable. Recommendation: ship `"rules"` as the default, treat it as an
observable behavior change (changelog + spec update), and keep revert
one click away. `"rules+llm"` is always explicit opt-in.

---

## 4. Phasing

| Phase | Content | Gate |
|---|---|---|
| **0** | Load each candidate GGUF against installed 0.2.2; probe `supports("pnc"/"itn")`; fix catalog `sha256` and filenames; record zh CER and latency on a local sample | Blocking. No catalog entry without a recorded successful load |
| **1** | Wire `pnc`/`itn`; add Layer A; settings + UI + i18n; tests | Covers "去掉语气词" with no new dependency |
| **2** | Layer B behind B1, with masking and guards | Covers "整理无用描述" |
| **3** | Swap the default ASR model if Phase 0 justifies it; revisit end-to-end formal ASR if FormalASR-class weights are released | Optional |

Phase 1 delivers most of the requested value and is independently shippable.

---

## 5. Files in scope

- `packages/voice-runtime/src/text-cleanup.ts` (new, pure)
- `packages/voice-runtime/src/transcription-engine.ts` (pnc/itn probing, cleanup wiring)
- `packages/voice-runtime/src/types.ts` (`TranscribeOptions`, cleanup settings, raw text on `VoiceResult`)
- `packages/voice-runtime/src/model-catalog.ts` (integrity fixes, new entries)
- `packages/shared/src/types/settings.ts` (`VoiceInputSettings.cleanup`)
- `apps/desktop/electron/main/voice-service.ts` (pass cleanup settings through)
- `apps/desktop/src/features/settings/voice/` and `apps/desktop/src/features/voice/` (settings UI, revert affordance)
- `packages/i18n/src/locales/*` (new keys, all locales)
- `docs/spec/` + a new ADR

## 6. Testing (per `AGENTS.md` § 12)

- Unit — Layer A: zh / en / mixed input, idempotence, demonstrative
  false-positive cases (`那个文件` must survive), empty-output fallback.
- Unit — masking: round-trip fidelity for paths, identifiers, URLs, numbers.
- Unit — guards: each rejection condition falls back to Layer A output.
- Integration — `TranscriptionEngine` with a fake model: `pnc`/`itn` applied
  only when `supports()` is true; cleanup applied in the right order relative
  to OpenCC.
- User path — dictate → Composer insertion with `off` / `rules` /
  `rules+llm`, plus revert to raw.
- Not run unless the user asks: `verify:ui:*`.

## 7. ADR required

A new ADR is needed before implementation: it adds a post-processing stage
that changes observable dictation output, extends the public settings surface,
and (in Phase 2) introduces a second model runtime. Suggested title:
*Dictation text cleanup pipeline*.

## 8. Risks

- **Phase 0 may invalidate the primary ASR pick.** If the installed native lib
  rejects Fun-ASR-Nano and Qwen3-ASR, Stage 1 stays on whisper-small until
  `transcribe-cpp` is upgraded — which is its own compatibility review.
- **Rules are language-specific.** The zh/en lists do not generalize to the
  other supported locales; non-covered languages pass through unchanged.
- **LLM polish can still be wrong inside guard limits.** Mitigated by review
  before send and one-click revert, not eliminated.
- **Memory.** A cleanup LLM resident next to an ASR model compounds the
  existing idle-unload concern; Layer B should release its runtime on the same
  idle timer.

## 9. Sources

- transcribe.cpp model docs: <https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/fun-asr-nano.md>, <https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/qwen3-asr.md>
- Qwen3-ASR-0.6B: <https://huggingface.co/Qwen/Qwen3-ASR-0.6B>
- FormalASR: <https://arxiv.org/html/2605.19266v1>
- s1-mini (English-only): <https://huggingface.co/superwhisper/s1-mini>, <https://superwhisper.com/docs/models/language>
- Qwen3-1.7B GGUF: <https://huggingface.co/Qwen/Qwen3-1.7B-GGUF>
