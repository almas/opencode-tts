# opencode-tts

Japanese text-to-speech for **OpenCode Desktop**, built on the experimental GUI plugin API. Select text, right-click, and listen — **fully offline**: synthesis runs on your machine with [Piper](https://github.com/rhasspy/piper), no cloud service, no account, no network calls.

日本語版: [下の「日本語」セクション](#日本語) を参照してください。

## Features

- **100% local synthesis** — the [Piper](https://github.com/rhasspy/piper) neural engine runs as a child process and speaks through a voice model on disk. Nothing you read aloud ever leaves the machine.
- **Right-click "選択した文字列を読み上げ"** (read selected text) on any selection in the chat view, via a floating context menu (the host has no plugin context-menu API yet, so the plugin renders its own Portal menu).
- **Read the previewed file aloud**: a header button and a command read whatever file the review panel has open (Markdown and code are cleaned up server-side before synthesis, and very long files are clipped).
- **Voices are discovered from disk** — every `*.onnx` model (with its `*.onnx.json` sidecar) in the voices directory is offered in the settings page, one entry per speaker the model defines.
- **Preferences persisted server-side** (`ctx.storage`, key `tts/prefs`): voice, speaking rate (-50%..+50%), auto-play of new assistant messages, keep-warm.
- Player panel with play/pause/stop and progress, header button, commands (`/tts`), and English/Japanese strings.

## Install

Requires OpenCode 2.x with the Desktop GUI (the GUI half loads through the `./gui-experimental` export).

### 1. Engine (one time)

The plugin shells out to the `piper` CLI. With [uv](https://docs.astral.sh/uv/):

```sh
uv tool install piper-tts --with pyopenjtalk-plus
```

(`pyopenjtalk-plus` is required for the Japanese phonemizer; without it synthesis fails with `ModuleNotFoundError: pyopenjtalk`.)

The plugin finds `piper` at `~/.local/bin/piper`, `/usr/local/bin`, `/usr/bin`, or on `$PATH`. Set `OC_TTS_PIPER_BIN` to point somewhere else.

### 2. A voice model

Download a voice into the voices directory (default `~/.local/share/opencode-tts/`, override with `OC_TTS_VOICES_DIR`). Example — the current Japanese voice from the [piper-voices collection](https://huggingface.co/rhasspy/piper-voices):

```sh
mkdir -p ~/.local/share/opencode-tts/voices && cd ~/.local/share/opencode-tts/voices
base=https://huggingface.co/rhasspy/piper-voices/resolve/main/ja/ja_JP/hi_fi_captain/medium
curl -LO "$base/ja_JP-hi_fi_captain-medium.onnx"
curl -LO "$base/ja_JP-hi_fi_captain-medium.onnx.json"
```

This download is a one-time setup step you run yourself; the plugin itself never touches the network.

### 3. Plugin registration

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "github:YOUR_GITHUB/opencode-tts" }
    // or: "/absolute/path/to/opencode-tts"
  ]
}
```

Then **fully restart the OpenCode background service** (quitting the window is not enough — the service is a separate process):

```sh
~/.config/ai.opencode.desktop/cli/*/opencode-cli service restart
```

A plugin's GUI half is registered only when the service boots, so without this restart you get no menu entry/button.

> If the engine or a model is missing, the settings page shows what is missing and the exact command to fix it; nothing fails silently.

## Build from source

```sh
npm install
npx tsc --noEmit
npx vitest run
npx vite build   # -> dist/gui-experimental.cjs (the GUI half)
```

The server half runs straight from `src/index.ts` (TypeScript is loaded by the host).

## How it works

```
GUI (gui.tsx)                      Server (index.ts + tts.ts)
  ctx.client.rpc(tts/*)  ->   /api/rpc/tts/<method>
  Web Audio (decoded buffer)  <-   base64 WAV
```

- `synthesizeWithPiper(...)` spawns `piper -m <model> -s <speaker> --length-scale <n>`, writes the text on stdin, and collects the WAV it writes to stdout (180 s timeout, abortable via the RPC control signal).
- The UI's rate percent maps to piper's `--length-scale` as `1 / (1 + rate/100)`.
- Markdown is stripped before synthesis (code blocks, links, tables…), long text is cut at a sentence near 6,000 characters, and paragraphs are flattened into one utterance.
- Prefs live in `ctx.storage` so they survive restarts and are shared by all clients. Old `ja-JP-*Neural` voice ids from the previous online engine reset to the default local voice automatically.
- The context menu: a capture-phase `contextmenu` listener finds the current selection and renders a Portal menu with 「選択した文字列を読み上げ」.
- The previewed file: each tab of the host's review panel carries `data-value="file://<workspace path>"` and the selected one is marked, so the plugin reads that path from the DOM, loads the file through `ctx.screen.current().file` and speaks it like any other text.

## Playback pops after idle (and how they are handled)

Some machines power down the audio output device after a few quiet seconds, and the device clicks or crackles while it powers back up — so the first playback after any gap (not just the first of the session) can start with a pop. The plugin defends in three layers:

- Every clip gets a ~120 ms silent lead-in, so any residual transient plays under silence.
- If nothing has been played for over 3 s, a short silent beat wakes the device first and playback starts after a brief settle delay.
- By default (`keepWarm`, on the settings page) a 20 ms silent heartbeat every 2 s keeps the device awake while the app is open, so cold starts rarely happen at all. Turn it off if you would rather the device stay suspended (e.g. to save power on speakers that draw attention when awake); the wake-before-play path then covers every cold start.

## 日本語

OpenCode Desktop に日本語読み上げ (TTS) を追加するプラグインです。**合成は完全にローカル**（Piper エンジン）で、外部のインターネットサービスは一切使いません。

- チャットの文章を選択して右クリック → **「選択した文字列を読み上げ」**
- ファイルプレビューパネルで開いているファイルもそのまま読み上げられます（ヘッダーボタンまたはコマンド）。
- 声は音声モデル置き場（既定 `~/.local/share/opencode-tts/voices`）から自動検出。`.onnx` と `.onnx.json` の組を置くだけで設定画面に現れます。
- 声の選択・話速（-50%〜+50%）・「新しいアシスタントメッセージを自動で読む」設定はサーバー側に保存されます。
- ヘッダーボタンと `/tts` コマンドからも操作できます。

エンジン導入（一度だけ）:

```sh
uv tool install piper-tts --with pyopenjtalk-plus   # 日本語話者化に pyopenjtalk-plus 必須
```

注意点:

- xrdp 越しセッションではサウンド再生先が無いことがあり、再生テストは実機で行ってください。
- 一部の機種ではスピーカー出力が数秒の無音で電源オフになり、復帰時のポップノイズが再生頭に載ることがあります。このプラグインは無音の前置き・アイドル検出による再生前のウェイクアップ・既定で有効な「オーディオデバイスを起動状態に保つ」心拍（2秒間隔の無音ビート）の三段構えでこれを吸収します。心拍が不要な場合は設定画面でオフにできます（オフでも再生前にウェイクアップが入ります）。

## Security notes

- **No credentials, no network.** The plugin makes zero outbound connections. Text is piped to the local `piper` process and never leaves the machine. 認証情報もネットワーク通信も一切ありません。
- Markdown stripping (`sanitizeForSpeech`) keeps code, URLs and markup from being read aloud; covered by `test/tts.test.ts`.

## Voice license and attribution

The Japanese voice referenced above, `ja_JP-hi_fi_captain-medium`, is distributed in the [piper-voices](https://huggingface.co/rhasspy/piper-voices) collection. Per its model card:

- Dataset: [NICT hi-fi-captain](https://ast-astrec.nict.go.jp/en/release/hi-fi-captain/) — licensed **CC BY-NC-SA 4.0** (non-commercial, share-alike). Check that this matches your use.
- Trained with [Piper](https://github.com/rhasspy/piper) (MIT); finetuned from the Hi-Fi TTS English base model.

You download voice models yourself during setup; keep each model's license terms in mind when choosing voices.

## Acknowledgements

- [Piper](https://github.com/rhasspy/piper) and the [piper-voices](https://huggingface.co/rhasspy/piper-voices) collection — the offline speech engine and models.
- The `@opencode/plugin/gui` experimental API (OpenCode 2.3).

## License

MIT (plugin code only — bundled/downloaded voice models carry their own licenses, see above)
