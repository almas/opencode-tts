# opencode-tts

Japanese text-to-speech for **OpenCode Desktop**. Select text, right-click, and
listen — **offline by default**: synthesis runs on your machine with
[Piper](https://github.com/rhasspy/piper) voice models, no account and no
network calls. One click picks the voice: local male/female/child voices, extra
free engines (VOICEVOX), or optional online Edge voices.

日本語版: [下の「日本語」セクション](#日本語) を参照してください。

## Features

- **One-click voice picker** — the 🔊 toolbar button (or the ⋯ menu) opens a
  dialog listing every available voice; press the row (or its number key) and
  the answer starts speaking immediately. Warm-up for the engine and models
  happens **in the background** the moment the plugin starts, so the first
  playback is not slowed by model loading.
- **Local synthesis by default** — Piper runs as a resident local server
  (loopback only, token-gated) with a voice model on disk. Nothing you read
  aloud leaves the machine unless you pick an online voice.
- **Fast start** — the resident server keeps the voice model in RAM and streams
  audio chunk by chunk: the GUI fetches the stream and starts playing while the
  rest of the sentence is still being synthesized (roughly 0.4 s to first audio
  versus ~1.6 s for one-shot synthesis; both timings depend on your machine).
- **Male / female / child voices** — multi-speaker models (e.g. the bundled
  setup with the Captain model) expose one row per speaker, and a `（子供風）`
  variant for each: synthesis is slowed slightly and the playback rate is
  raised, which reads as a lighter, child-like voice. It's a cheap trick, but
  it works well in practice.
- **Extra free engines** — [VOICEVOX](https://voicevox.hiroshiba.jp/) is added
  automatically when its app is running (it serves a free local API at
  `127.0.0.1:50021`) — its full set of Japanese voices appears in the picker.
  An optional [Microsoft Edge voices](https://learn.microsoft.com/azure/ai-services/speech-service/language-support)
  engine (online) can be used by selecting an `edge:` voice.
- **Right-click "選択した文字列を読み上げ"** on any selection in the chat view,
  plus ⏹/⏸ controls in the composer, a per-message 🔊 button on assistant
  replies, and ⌘⇧X / Ctrl+Shift+X to read the latest reply.
- **Reads only the reply** — assistant markdown is cleaned for speech
  (code fences and inline code dropped, symbols normalized to words), tool
  output is never read, and each message plays at most once.
- **Auto-play (optional)** — start a question and the answer speaks by itself
  when it lands. A new prompt cancels the previous audio first, so answers
  never talk over each other.
- **Settings UI** — voice picker, speech-rate slider with instant preview,
  toggles for auto-play, background warm-up, the voice dialog, and fast start.
- **Lightweight** — the engine is the free `piper-tts` Python package (uv
  tool); the plugin itself only adds a small local server and the UI.

## Requirements

- **OpenCode Desktop** (the plugin uses the experimental GUI plugin API for the
  toolbar button and dialogs).
- **`uv`** — install it first: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **`piper-tts`** — one-off: `uv tool install piper-tts`
- **A voice model** — put a Piper model (`.onnx` + `.onnx.json`) in
  `~/.local/share/opencode-tts/voices/`. The README of this repo's setup uses
  [Piper 1.7.0's bundled Captain model](#installing-the-japanese-model)
  (CC BY-NC-SA 4.0 — non-commercial).

The plugin auto-starts the resident engine when the Desktop app loads it;
if `piper-tts` is missing, every local row simply stays out of the picker.

## Install

```bash
uv tool install piper-tts     # the TTS engine (once)
mkdir -p ~/.local/share/opencode-tts/voices
cd ~/.config/opencode
npm install github:almas/opencode-tts
python3 - <<'PY'
import json
p = "opencode.jsonc"
raw = open(p).read()
start = raw.index("//") if raw.lstrip().startswith("//") else 0
brace = raw.index("{")
data = json.loads(raw[brace:])
plugins = data.setdefault("plugin", [])
entry = "opencode-tts/gui"
gui = "opencode-tts/gui-experimental"
if entry not in plugins:
    plugins.insert(0, entry)
if gui not in plugins:
    plugins.append(gui)
open(p, "w").write(raw[:brace] + json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print("registered:", plugins)
PY
```

The snippet keeps `opencode.jsonc` valid even when it starts with `//`
comments. Then restart the Desktop app. Upgrading later:
`cd ~/.config/opencode && npm update opencode-tts`.

## Usage

- Select text in the chat view and choose **選択した文字列を読み上げ** from the
  floating menu that appears. If the dictionary plugin is installed, the menu
  is shared: its **辞書で引く** row joins the same menu instead of replacing
  the reading rows.
- Click the **🔊 ボイス** button in the composer (or ⌘⇧X / Ctrl+Shift+X) to read
  the latest reply. The first click opens the voice dialog — pick a row and it
  speaks; later clicks speak with your chosen voice and the dialog is skipped
  until you turn it on again in Settings or pick "…" → 音声選択.
- Use ⏹ to stop the current audio, and ⏸ to toggle the pause icon while
  something is playing.
- Open **Settings → opencode-tts** to switch voice, rate, auto-play, the
  voice dialog, and fast start.

Nothing is spoken until you trigger it; enabling **Auto-play** opts into
speaking each new assistant reply automatically.

## Installing the Japanese model

Download the two Japanese model files shipped with Piper (CC BY-NC-SA 4.0,
non-commercial — see `~/.local/share/opencode-tts/voices/MODEL_CARD` for the
full statement):

```bash
DIR=~/.local/share/opencode-tts/voices
mkdir -p "$DIR"
cd "$DIR"
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/ja/ja_JP/hi_fi_captain/medium
wget -O ja_JP-hi_fi_captain-medium.onnx      "$BASE/ja_JP-hi_fi_captain-medium.onnx"
wget -O ja_JP-hi_fi_captain-medium.onnx.json "$BASE/ja_JP-hi_fi_captain-medium.onnx.json"
```

The directory can be moved with the `OC_TTS_VOICES_DIR` environment variable,
or by setting `voices_dir` in a plugin config file (not implemented — PRs
welcome). The plugin scans this directory at startup and once per minute.

## Offline guarantees

With a local voice selected, synthesis is fully offline: the plugin starts a
Python HTTP server bound to `127.0.0.1` (random port, token header, auto-exit
after 10 idle minutes), and the GUI streams audio from it. No DNS or HTTP
request leaves the machine for local voices. VOICEVOX voices are served by the
VOICEVOX app on your machine (also local). **Selecting an Edge voice sends
read text to Microsoft's online service** — those rows are tagged
「オンライン」and you should only enable them deliberately.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OC_TTS_VOICES_DIR` | Directory holding `*.onnx` + `*.onnx.json` voice models (default `~/.local/share/opencode-tts/voices`). |
| `OC_TTS_PIPER_PYTHON` | Python interpreter with the `piper` package (default: uv tool path, then any importable `python3`). |

## Development

```bash
npm install
npm test          # vitest: text preview, piper helpers, edge client, catalog
npx vite build    # rebuild dist/gui-experimental.cjs after editing src/gui.tsx
```

`assets/piper_server.py` is the resident synthesis server (plain stdlib + the
`piper` package); `src/audio_server.ts` supervises it.

## Architecture

```
src/index.ts        plugin entry — TTS RPCs (speak/catalog/audioInfo/stop…), prefs,
                    background warm-up, notification command + shortcut
src/gui.tsx         UI — voice dialog, toolbar button, selection menu, message
                    buttons, per-message guards, ⏹/⏸ controls, Settings view
src/rpc.ts          server ↔ GUI contract (schemas shared by both sides)
src/tts.ts          Piper model discovery + one-shot CLI fallback
src/audio_server.ts resident Piper HTTP server (spawn, health, stream, models)
src/edge.ts         dependency-free online Edge voices client (used only for edge: voices)
src/voicevox.ts     VOICEVOX local-API probe + synthesis
assets/piper_server.py  the resident engine (stdlib http.server + piper)
```

The plugin registers one RPC namespace (`opencode-tts`): `speak`, `stop`,
`status`, `audioInfo`, `catalog`, and `getPrefs`/`setPrefs`. Preferences
(voice, rate, auto-play, warm-up, dialog, fast start) persist through the
host's storage. The GUI never talks to the synthesis server except over
loopback with the token `audioInfo` hands it.

## 日本語

**OpenCode Desktop** に日本語読み上げを追加するプラグインです。テキストを
選択して右クリック、または 🔊 ボタンでそのまま読み上げます。既定は**完全
オフライン** — [Piper](https://github.com/rhasspy/piper) があなたのマシンで
合成するので、アカウントも通信も不要です（オンライン音声を選ぶ場合のみ通信
します）。

> [!WARNING]
> 収録する日本語音声モデル（Captain / hi_fi_captain）は **CC BY-NC-SA 4.0
> （非商業目的のみ）** のライセンスです。個人利用は問題ありませんが、商用
> 環境では利用しないでください（詳細は `voices/MODEL_CARD`）。

### できること

- **ワンクリック音声选择** — 🔊 ボタン（または ⋯ メニュー）で音声ダイヤログが
  開き、ローカル・オンライン・男性・女性・子供風を一覧から選んで即読み上げ。
  エンジンとモデルの**ウォーミングアップは起動直後から裏で実行**するので、
  最初の 1 回からすぐ聞こえます。
- **ローカル合成（Piper）** — Piper を常駐ローカルサーバー（127.0.0.1 のみ、
  トークン認証）として動かし、モデルをメモリに置いたまま音声を出します。
- **高速スタート** — 音声をチャンク配信し、GUI は先頭から再生を開始します
  （初音まで約 0.4 秒。使い方やマシンによります）。
- **男性・女性・子供声** — 話者複数モデルは話者ごとに表示、さらに各話者の
  「（子供風）」は合成を少し遅くし再生速度を上げる疑似子供声です。
- **追加の無料エンジン** — [VOICEVOX](https://voicevox.hiroshiba.jp/) アプリが
  起動中なら、その全音声が自動でダイヤログに加わります（本地 API・無料）。
  オンラインの Microsoft Edge 音声も選べます。
- **選択読み上げ・最新返信の読み上げ** — テキスト選択のメニュー、メッセージ
  下の 🔊 ボタン、⌘⇧X / Ctrl+Shift+X、入力欄の ⏹ / ⏸。
- **自動再生（任意）** — 質問を送ると、完成した返信を自動で読み上げます。
  新しい送信では前の再生を自動的に止めます。
- **設定 UI** — 音声選択、話速スライダー（試聴つき）、自動再生、裏の
  ウォーミングアップ、音声ダイヤログ、高速スタートの ON/OFF。

### 使い方

1. 上の [Install](#install) を実行し、Desktop アプリを（`/reload` でなく）
   終了して開き直します。
2. 日本語モデルを 1 つ `~/.local/share/opencode-tts/voices/` に置きます
   （[Installing the Japanese model](#installing-the-japanese-model) 参照。
   Piper に同梱の ja_JP モデルは CC BY-NC-SA 4.0・非商業制限です）。
3. Desktop で音声を読み上げさせたい場合は、既定で「最新返信を再生」に
   なっている再生メニューから実行するか、入力欄の 🔊 ボタンから音声を選び
   ます。返信が着信したら自動で読んでほしい場合は設定の「自動再生」を ON に
   します。

読み上げを手動で始める限り、通信も再生も一切行いません。「自動再生」を ON に
すると、新しい assistant のテキスト確定時に自動で読み上げます。

### 仕組み（技術メモ）

`assets/piper_server.py` が常駐合成サーバー（Python 標準ライブラリ + piper
パッケージ）で、`src/audio_server.ts` がその起動・健康確認・チャンク配信を
担当します。モデルは初回リクエスト時に遅延ロードし、以降はメモリに保持
します。音声 ID は `piper:<stem>#<speaker>[!child]` / `voicevox:<id>` /
`edge:<ShortName>` の形式で、設定に保存します。初設定や旧バージョンからの
マイグレーションは自動です。詳細は上の [Architecture](#architecture) を
参照してください。

### 開発

```bash
npm install
npm test          # テキスト整形・Piper 発話・Edge クライアント・音声カタログ
npx vite build    # src/gui.tsx を編集したら dist/gui-experimental.cjs を再生成
```

### 関連リンク

- [Piper](https://github.com/rhasspy/piper) — 完全ローカルの TTS エンジン
- [Piper 1.7.0 同梱の日本語モデル](https://github.com/rhasspy/piper/blob/1.7.0/VOICES.md)（CC BY-NC-SA 4.0、非商業）
- [VOICEVOX](https://voicevox.hiroshiba.jp/) — 無料の日本語音声エンジン（アプリ起動時に自動検出）
- [Microsoft Edge の音声一覧](https://learn.microsoft.com/azure/ai-services/speech-service/language-support)（オンライン音声を選ぶ場合のみ）
- [OpenCode](https://opencode.ai/) — このプラグインが動く AI コーディング エージェント

## License

MIT (plugin code). The Japanese voice model is CC BY-NC-SA 4.0 (non-commercial)
— see `~/.local/share/opencode-tts/voices/MODEL_CARD`.
