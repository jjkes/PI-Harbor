# 23. 本地 Dictation（听写）

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/23-local-dictation) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 事实来源：`packages/voice-runtime/src/`、
> `apps/desktop/electron/main/voice-service.ts`。
> ADR：[0341-local-dictation-with-transcript-cleanup](../../../adr/0341-local-dictation-with-transcript-cleanup.md)。

## 1. 范围

Dictation 在本机把语音变成 Composer 草稿文本。Electron Main 用 PvRecorder
采集麦克风，用 transcribe-cpp 0.2.2 转写，清理文本，再由 Renderer 插入草稿。
它永远不会发送草稿。

当允许本地工具且 `settings.voice.enabled` 为 true 时，Dictation 对用户可见：
Composer 显示一个麦克风控件，「设置 → Voice」显示 Dictation 卡片。它不受
开发者模式限制，也不受构建类型限制。

实时语音（[live-voice.md](live-voice.md)）与宿主语音
（[20-speech.md](20-speech.md)）是独立能力。实时语音保留其开发者模式与开发
构建门控；宿主语音仍不出现在设置中（ADR 0291）。

## 2. 流水线

```
麦克风（PvRecorder，Electron Main）
  → PCM
  → transcribe-cpp 识别器            （Main；语言锁定、ITN、标点）
  → OpenCC 中文变体转换
  → 清理                            （off | rules | llm）
  → Renderer 插入 Composer 草稿
```

除插入之外的每一步都在 Electron Main 内完成，但 `llm` 清理模型例外，它运行
在独立的 utility 进程中（见 §6）。结果同时保留两份文本：`text` 用于插入，
`rawText` 是识别器的原始输出。用户可以把已插入的文本换回 `rawText`
（「恢复原文」），草稿的其余内容保持不变。任何内容都不会自动发送。

录音期间，Main 还会在累计至少 0.6 秒音频后约每 0.8 秒转写一次，并把最新
文本作为 `partialText` 放入 `VoiceState`。该预览即使在 `llm` 模式下也只做
规则清理，且同一时间只运行一遍。停止时的最终转写会等待在途预览结束，再用
权威的清理结果替换预览。预览失败只写入诊断日志，不会结束录音。Composer
替换预览尾部时不会抢走焦点，并保留用户在预览之后输入的文字。控件始终只有
一个麦克风/停止按钮，不显示录音时长或取消操作。

「设置 → 快捷键」提供 **按住听写**（`dictationPushToTalk`，默认 `Mod+T`，
macOS 显示为 Command+T）。按下绑定键开始听写，松开后停止并转写；按键重复会被忽略。
窗口失焦或文档隐藏会安全地触发松开。该操作只在开启听写的聊天页生效，并遵循普通
快捷键的重新绑定、禁用和冲突规则。

## 3. 采集与识别

只选择一种语言会把识别器锁定到该语言。选择多种语言时由识别器自动检测；若
检测到的语言不在所选语言之内，该段音频会按第一个所选语言重新转写一次。

当已加载的模型报告支持时，会请求逆文本规范化（`itn`）与标点（`pnc`）。

时长短于 0.3 秒的片段转写为空文本，不会插入任何内容。

实时语音与 Dictation 共用 Main 进程的麦克风租约；每次结束都会释放。

## 4. 设置

`AppSettings.voice`：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 是否提供 Dictation 控件 |
| `deviceId` | 麦克风；`null` 表示系统默认 |
| `languages` | 用户的听写语言，例如 `["zh", "en"]` |
| `chineseVariant` | `simplified`、`traditional-taiwan`、`traditional-hong-kong` |
| `modelId` | 所选转写模型的目录 id |
| `cleanupMode` | `off`、`rules`（缺省时的默认值）、`llm` |

host-core 以不透明 JSON 存储该值。存储 schema 版本没有变化，既有字段保持原有
含义。Electron Main 在 IPC 边界校验 Renderer 提供的设置补丁与模型 id
（`packages/voice-runtime/src/settings.ts`）：未知键与非法值会被丢弃，不会到达
Controller 或原生识别器。

## 5. 状态与 IPC 合约

本功能没有新增通道。既有接口如下：

| 通道 | 用途 |
| --- | --- |
| `pi-harbor/voice/start` | 用校验过的设置开始一次录音 |
| `pi-harbor/voice/stop` | 停止录音并转写 |
| `pi-harbor/voice/cancel` | 取消录音或转写 |
| `pi-harbor/voice/getState` | 当前 `VoiceState` |
| `pi-harbor/voice/getDevices` | 输入设备 |
| `pi-harbor/voice/getModels` | 目录条目及各模型状态 |
| `pi-harbor/voice/downloadModel` | 下载一个目录模型 |
| `pi-harbor/voice/deleteModel` | 删除一个已下载模型 |
| `pi-harbor/voice/updateSettings` | 应用校验过的设置补丁 |
| `pi-harbor/voice/checkPermission` | 麦克风权限状态 |
| `pi-harbor/voice/requestPermission` | 请求麦克风权限 |
| `pi-harbor/voice/event/stateChanged` | 推送 `VoiceState` |
| `pi-harbor/voice/event/modelProgress` | 推送下载进度 |

阶段：`idle`、`preparing`、`ready`、`starting`、`listening`、
`transcribing`、`done`、`error`、`cancelling`。从 `done` 和 `error` 都可以
再次开始录音。转写过程中取消会进入非错误终态，而不是 `error`。

`VoiceState` 携带 `phase`、`durationSeconds`、`volumeLevel`、`listening`
期间可替换的 `partialText`、可选的诊断 `error`、可选的 `errorCode`，以及
`phase` 为 `done` 时的 `result`。

`VoiceResult`：

```
{
  text,            // 清理后用于插入的文本
  rawText,         // 识别器输出，用于「恢复原文」
  cleanup: { mode, applied, fallback? },
  speechSeconds,
  transcribeSeconds,
  language
}
```

`ModelInfo.kind` 为 `transcription` 或 `cleanup`，因此同一份目录同时服务识别器
与清理模型。

## 6. 清理

`packages/voice-runtime/src/cleanup/`。

### 6.1 `rules`（默认）

只做确定性的、无歧义的语气词删除：

- 中文 嗯/呃 等迟疑词。
- 额/唔/哦/噢/诶/欸/哎 以及 那个/这个/就是说/怎么说呢/你知道吗，仅当它们
  在停顿之间独立出现时。
- 分句开头、紧接人称代词之前的 那个。
- 重复的连接词（那个那个、然后然后……）。
- 口吃（我我我、我，我想）。
- 英文 `um`/`uh`/`erm`/`hmm`/`ah`、被逗号包围的 "you know"、三连重复词、
  重复的功能词。英文规则仅在英文是检测到或所选语言时生效。

有歧义的词（这个、然后、就是、"like"、"I mean"）一律保留：删除它们可能改变
说话人的本意。

### 6.2 `llm`

先执行规则，再由内置本地模型去掉自我更正与重复：Qwen3-1.7B Q4_K_M GGUF，
通过 node-llama-cpp 3.22.2 加载，只用预编译二进制（`build: "never"`）、
贪心解码、抑制 thinking、上下文 2048。

该模型**不在** Electron Main 中运行。node-llama-cpp 3.22.2 与
transcribe-cpp 0.2.2 各自带有自己的 ggml 构建，且使用相同的 dylib 安装名
（`@rpath/libggml-base.dylib`）但版本不同；在同一进程内同时加载会在 macOS
arm64 上以 SIGSEGV（退出码 139）崩溃。识别器留在 Main；清理模型运行在
Electron `utilityProcess` 中（`out/main/voice-polisher-worker.js`，由
`packages/voice-runtime/src/cleanup/polisher-worker.ts` 构建）。Main 通过
`ProcessPolisher` 以按 id 匹配的请求/响应协议驱动它
（`packages/voice-runtime/src/cleanup/polisher-protocol.ts`）：`prepare`、
`polish`、`abort`，结果为 ok 或 error。

### 6.3 保护

代码、URL、路径、文件名、标识符、数字以及中文中的拉丁术语会被掩码为 `⟦n⟧`
出现以下情况时拒绝模型输出：

- 占位符重复或被凭空创造，
- 占位符被删除且没有自我更正提示词（不对、算了、
  "actually"、"scratch that"……），
- 输出的可比较单元不是掩码输入的纯删除子序列（禁止增加、替换或调序；
  比较时忽略标点和空白），
- 删除了自我更正提示词之外的否定词，
- 剩余内容过少，或出现 think 标签。

因此，需要替换或调序才能完成的更正会回退到规则清理文本，而不会冒险改写语义。

掩码同时意味着这些片段被冻结：受保护片段内部的识别错误（例如把 "token" 听成
"ken"）不会被纠正。

### 6.4 回退

任何问题都保留规则清理后的文本，并在 `cleanup.fallback` 中说明原因：

| 回退值 | 原因 |
| --- | --- |
| `model-missing` | 清理模型不可用 |
| `too-long` | 输入超过 500 字符，跳过模型 |
| `timeout` | 生成超过 15 秒 |
| `rejected` | 保护规则拒绝了输出 |
| `failed` | Worker 或模型报错，包括 Worker 崩溃 |

清理问题永远不会变成听写错误。

## 7. 模型、下载与完整性

下载使用 Electron `net.fetch`，因此应用的网络代理设置生效。固定文件从
`https://huggingface.co/<repo>/resolve/main/<file>` 获取；当该主机无法提供文件
（连接被重置、30 秒内无响应，或返回 5xx/408/429）时，会以相同路径回退到
`https://hf-mirror.com`；而 404 这类确定性答复会直接结束下载，不会重复尝试。
`PI_VOICE_MODEL_HUB` 可用逗号分隔的来源列表替换这一顺序。

字节先写入 `<dataDir>/voice-models/<id>/<file>.part`，按目录中记录的摘要做
失败会保留它，下次尝试用 `Range` 从当前长度续传（返回 `200` 或拒绝该范围时从 0
重来）。被取消的下载同样可以续传。每次失败都会把原因记录在模型状态上，设置页会在
重试按钮旁显示该原因。`@huggingface/hub` 已不是依赖。

| id | kind | 文件 | 字节数 |
| --- | --- | --- | --- |
| `sensevoice-small` | transcription | `SenseVoiceSmall-Q8_0.gguf` | 252,684,608 |

当内置来源不可达时，模型行提供**手动下载**链接（同一个固定 URL）和**导入文件**
操作。导入会打开文件选择器，随后按目录中记录的字节数与 SHA-256 校验所选文件，
校验通过才安装为该模型；不匹配则拒绝并在该行显示原因。导入前会先卸载该模型，
并清除它中断的下载分片。

| `fun-asr-nano` | transcription | `Fun-ASR-Nano-2512-Q8_0.gguf` | 891,271,072 |
| `whisper-large-v3-turbo` | transcription | `whisper-large-v3-turbo-Q8_0.gguf` | 886,381,728 |
| `whisper-medium` | transcription | `whisper-medium-Q8_0.gguf` | 831,538,144 |
| `whisper-small` | transcription | `whisper-small-Q8_0.gguf` | 269,751,136 |
| `qwen3-1.7b` | cleanup | `Qwen3-1.7B-Q4_K_M.gguf` | 1,107,409,472 |
zh / en / yue / ja / ko 推荐 `sensevoice-small`，其他语言推荐
`whisper-large-v3-turbo`。SenseVoice Small、Fun-ASR-Nano 与 Whisper Small 已在
Apple M5 上用 transcribe-cpp 0.2.2 实际加载并转写；Whisper Medium 与 Large 与
Whisper Small 出自同一转换器。

在打包构建中，koffi（transcribe-cpp 使用）按路径 dlopen 原生库，无法读取
`app.asar` 内部，因此 Main 会把 `TRANSCRIBE_LIBRARY` 指向解包后的库
（`apps/desktop/electron/main/voice-native-paths.ts`）。`asarUnpack` 覆盖
koffi、`@koromix`、`@transcribe-cpp`、node-llama-cpp 的 bins 与
`@node-llama-cpp`。

## 8. 生命周期

识别器在 Main 中延迟加载，并在终态下十分钟没有新录音后卸载。开始录音会取消
待执行的卸载；下一次录音从磁盘缓存重新加载。

清理 Worker：

| 事件 | 结果 |
| --- | --- |
| 首次 `llm` 清理 | 启动并 `prepare` |
| 在 `llm` 模式下开始录音 | 预热 |
| 十分钟空闲卸载 | 结束进程 |
| 清理模式离开 `llm` | 结束进程 |
| 删除清理模型之前 | 结束进程 |
| 应用退出 | 结束进程 |
| Worker 崩溃 | 拒绝进行中的请求，回退到规则文本（`failed`），下次请求重新启动 |
| 取消 | 转发给 Worker；生成停止 |

在 MacBook Pro M5（macOS 27、Metal）上用 macOS TTS 片段实测：SenseVoice
Small Q8_0 加载耗时 0.3–0.45 秒，6–8 秒片段转写 65–110 毫秒，23 秒片段 425
毫秒；45 秒片段没有被截断。清理 Worker 首次 `prepare`（启动加冷加载）9.8
秒，热重启 1.7 秒，单句 polish 250–1250 毫秒。Worker RSS 约 1.7 GB，Main 约
0.3 GB。abort 约 50 毫秒内拒绝且下一次请求正常执行；被 SIGKILL 的 Worker 约
60 毫秒内拒绝，下一次调用会重新启动它。

## 9. 错误

`VoiceState.errorCode` 是稳定的分类；Renderer 负责本地化，`error` 仅作诊断。

| 代码 | 含义 |
| --- | --- |
| `no-model` | 没有选择转写模型 |
| `model-not-downloaded` | 所选模型不在磁盘上 |
| `microphone-denied` | 麦克风权限被拒绝 |
| `failed` | 其他失败，诊断信息在 `error` 中 |

清理问题在这里从不作为错误出现：它通过 `cleanup.fallback` 降级（见 §6.4）。

## 10. 隐私

音频与文本都留在本机。除用户自己保留的 Composer 草稿之外不做任何持久化，也
不会把文本发给任何 Provider。模型下载是本功能产生的唯一网络流量。
