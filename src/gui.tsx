/**
 * Read Aloud — the GUI half of the plugin.
 *
 * Talks to the server half over the `read-aloud` RPC domain: it fetches
 * assistant replies, asks for synthesized mp3 audio, and plays it in a single
 * <audio> element. Sessions, the speech service and user preferences all live
 * on the server side; this file only draws and plays.
 */
import { For, Show, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Command, Panel, Plugin, SettingsPage, Slot, type MountedSession } from "@opencode/plugin/gui"
import { ReadAloudRpc, type Prefs, type ReplyItem, type SpeakResult, type VoiceItem } from "./rpc"

/** The host components we use; the public types keep the registry open, so we type the calls. */
interface IconProps {
  name: string
  size?: "small" | "normal" | "large"
  class?: string
}

/** `SlotMap["session.header"]`: the session and active fields are reactive getters. */
interface HeaderProps {
  readonly screen: unknown
  readonly session: MountedSession
  readonly active: boolean
  readonly compact: boolean
}

/** `PanelProps`: reactive getters; access through the props object, never destructure. */
interface PanelPropsLike {
  readonly tab: unknown
  readonly session: MountedSession
  readonly screen: unknown
}

interface RpcLike {
  speak(input: { sessionID?: string; messageID?: string; text?: string }): Promise<unknown>
  replies(input: { sessionID: string }): Promise<unknown>
  latest(input: { sessionID: string }): Promise<unknown>
  voices(): Promise<unknown>
  prefs(): Promise<unknown>
  setPrefs(input: Partial<Prefs>): Promise<unknown>
}

const DEFAULT_PREFS: Prefs = { voice: "ja-JP-NanamiNeural", rate: 0, autoPlay: false }

/**
 * Flatten anything thrown by the SDK into readable text. The client throws
 * plain objects (ApiError/RpcError shapes), which would otherwise render as
 * `[object Object]` in toasts and in the app log.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>
    const parts: string[] = []
    if (typeof e._tag === "string") parts.push(e._tag)
    else if (typeof e.name === "string" && e.name) parts.push(e.name)
    if (typeof e.type === "string" && e.type) parts.push(e.type)
    if (typeof e.message === "string" && e.message && !parts.includes(e.message)) parts.push(e.message)
    if (typeof e.status === "number" && e.status) parts.push(`HTTP ${e.status}`)
    if (parts.length) return parts.join(": ").slice(0, 300)
    try {
      const json = JSON.stringify(error)
      if (json && json !== "{}") return json.slice(0, 300)
    } catch {
      // circular — fall through
    }
  }
  return String(error)
}

/**
 * The GUI bundle can mount before the server half of the plugin answers RPC
 * (a cold service boot registers both halves in sequence), so startup reads
 * retry with a gentle backoff instead of leaving defaults silently in place.
 * A service restart plus SDK reconnect can take ~20s, so the schedule covers
 * roughly 30 seconds before giving up.
 */
async function retryRpc<T>(label: string, call: () => Promise<T>, attempts = 10, baseDelayMs = 800): Promise<T | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt === attempts) {
        console.error(`[read-aloud] ${label} failed: ${errorText(error)}`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(baseDelayMs * attempt, 5000)))
    }
  }
  return undefined
}

function rateLabel(rate: number): string {
  return rate === 0 ? "1.0x" : `${(1 + rate / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`
}

export default Plugin.define({
  i18n: {
    en: {
      "read-aloud.name": "Read Aloud",
      "read-aloud.panel.title": "Read Aloud",
      "read-aloud.action.play": "Read the latest reply aloud",
      "read-aloud.action.play-item": "Read this reply aloud",
      "read-aloud.action.stop": "Stop reading aloud",
      "read-aloud.action.refresh": "Reload replies",
      "read-aloud.action.settings": "Read Aloud settings",
      "read-aloud.command.latest": "Read Aloud: read the latest reply",
      "read-aloud.command.selection": "Read Aloud: read the selection",
      "read-aloud.command.stop": "Read Aloud: stop",
      "read-aloud.command.open": "Read Aloud: show replies",
      "read-aloud.empty": "No reply to read yet",
      "read-aloud.no-session": "Open a session to read its replies aloud.",
      "read-aloud.reply-count": "{count} replies",
      "read-aloud.error": "Read Aloud failed",
      "read-aloud.settings.title": "Read Aloud",
      "read-aloud.settings.voice": "Voice",
      "read-aloud.settings.rate": "Speed",
      "read-aloud.settings.auto-play": "Read new replies aloud when the assistant finishes",
      "read-aloud.context.read": "Read the selection aloud",
      "read-aloud.context.stop": "Stop reading aloud",
    },
    ja: {
      "read-aloud.name": "読み上げ",
      "read-aloud.panel.title": "読み上げ",
      "read-aloud.action.play": "最新の返信を読み上げる",
      "read-aloud.action.play-item": "この返信を読み上げる",
      "read-aloud.action.stop": "読み上げを停止",
      "read-aloud.action.refresh": "一覧を再読込",
      "read-aloud.action.settings": "読み上げの設定",
      "read-aloud.command.latest": "読み上げ：最新の返信を読み上げる",
      "read-aloud.command.selection": "読み上げ：選択した文字列を読み上げる",
      "read-aloud.command.stop": "読み上げ：停止",
      "read-aloud.command.open": "読み上げ：返信一覧を表示",
      "read-aloud.empty": "読み上げられる返信がありません",
      "read-aloud.no-session": "セッションを開くと、その返信を読み上げできます。",
      "read-aloud.reply-count": "{count} 件の返信",
      "read-aloud.error": "読み上げに失敗しました",
      "read-aloud.settings.title": "読み上げ",
      "read-aloud.settings.voice": "音声",
      "read-aloud.settings.rate": "速度",
      "read-aloud.settings.auto-play": "アシスタントの応答完了後、新しい返信を自動で読み上げる",
      "read-aloud.context.read": "選択した文字列を読み上げ",
      "read-aloud.context.stop": "読み上げを停止",
    },
  },
  setup(ctx) {
    const rpc = ctx.client.rpc(ReadAloudRpc) as unknown as RpcLike
    // The host Ui registry is open in the public types; we type the icon call.
    const Icon = (ctx.ui as unknown as { Icon: (props: IconProps) => JSX.Element }).Icon

    // ---------- preferences ----------
    const [prefs, setPrefs] = createSignal<Prefs>({ ...DEFAULT_PREFS })
    const [voices, setVoices] = createSignal<VoiceItem[]>([])
    void retryRpc("prefs", () => rpc.prefs()).then((value) => {
      if (value) setPrefs(value as Prefs)
    })
    void retryRpc("voices", () => rpc.voices()).then((value) => {
      if (value) setVoices((value as { voices: VoiceItem[] }).voices)
    })

    const savePrefs = async (patch: Partial<Prefs>) => {
      const next = { ...prefs(), ...patch }
      setPrefs(next)
      try {
        setPrefs((await rpc.setPrefs(next)) as Prefs)
      } catch (error) {
        console.error(`[read-aloud] setPrefs failed: ${errorText(error)}`)
        ctx.toast.show({ title: ctx.t("read-aloud.error"), description: errorText(error), variant: "error" })
      }
    }

    // ---------- audio engine ----------
    let audio: HTMLAudioElement | undefined
    let token = 0
    const [playingId, setPlayingId] = createSignal("")
    const [busyId, setBusyId] = createSignal("")

    const halt = () => {
      if (audio) {
        audio.pause()
        audio.src = ""
        audio = undefined
      }
      setPlayingId("")
    }

    const stop = () => {
      token += 1
      halt()
      setBusyId("")
    }

    const playAudio = (base64: string, marker: string) =>
      new Promise<void>((resolve, reject) => {
        const el = new Audio(`data:audio/mpeg;base64,${base64}`)
        el.addEventListener("ended", () => {
          if (audio === el) audio = undefined
          if (playingId() === marker) setPlayingId("")
        })
        el.addEventListener("error", () => reject(new Error("audio playback failed")))
        audio = el
        setPlayingId(marker)
        el.play().then(
          () => resolve(),
          () => reject(new Error("audio playback blocked")),
        )
      })

    let lastReadId = ""

    const play = async (input: { sessionID?: string; messageID?: string; text?: string }, marker: string) => {
      stop()
      const mine = token
      setBusyId(marker)
      try {
        const result = (await rpc.speak(input)) as SpeakResult
        if (mine !== token) return
        if (!result?.audio) {
          ctx.toast.show({ title: ctx.t("read-aloud.empty"), variant: "default" })
          return
        }
        if (result.messageID) lastReadId = result.messageID
        await playAudio(result.audio, marker)
      } catch (error) {
        if (mine !== token) return
        console.error(`[read-aloud] speak failed: ${errorText(error)}`)
        ctx.toast.show({ title: ctx.t("read-aloud.error"), description: errorText(error), variant: "error" })
      } finally {
        if (busyId() === marker) setBusyId("")
      }
    }

    const playLatest = (session: MountedSession | undefined) => {
      if (!session) return
      void play({ sessionID: session.id }, "latest")
    }

    const playSelection = () => {
      const text = window.getSelection()?.toString().trim() ?? ""
      if (!text) {
        ctx.toast.show({ title: ctx.t("read-aloud.empty"), variant: "default" })
        return
      }
      void play({ text }, "selection")
    }

    // ---------- auto play ----------
    // One event stream for the window: on `session.idle`, read the reply the
    // assistant just finished, if it is the session on screen and nothing is playing.
    const autoAbort = new AbortController()
    onCleanup(() => autoAbort.abort())
    void (async () => {
      try {
        const stream = ctx.client.event.subscribe({
          types: ["session.idle"],
          signal: autoAbort.signal,
        }) as unknown as AsyncIterable<{ type?: string; data?: { sessionID?: string } }>
        for await (const event of stream) {
          if (autoAbort.signal.aborted) return
          if (event.type !== "session.idle") continue
          if (!prefs().autoPlay) continue
          if (audio && !audio.paused) continue
          const current = ctx.sessions.current()
          if (!current || current.id !== event.data?.sessionID) continue
          const latest = (await rpc.latest({ sessionID: current.id })) as { reply?: ReplyItem | null }
          const reply = latest.reply
          if (!reply || reply.id === lastReadId) continue
          lastReadId = reply.id
          if (autoAbort.signal.aborted) return
          await play({ text: reply.text }, reply.id)
        }
      } catch (error) {
        if (!autoAbort.signal.aborted) console.error("[read-aloud] auto play", error)
      }
    })()

    // ---------- contributions ----------
    const openPanel = () => {
      const target = ctx.sessions.current()
      if (target) ctx.layout.open(`${ctx.id}:replies`, target, { tab: "select" })
    }

    ctx.add(Command, {
      id: "read-aloud.speak-latest",
      get title() {
        return ctx.t("read-aloud.command.latest")
      },
      run: () => playLatest(ctx.sessions.current()),
    })
    ctx.add(Command, {
      id: "read-aloud.speak-selection",
      get title() {
        return ctx.t("read-aloud.command.selection")
      },
      keywords: "selection selection TTS speech",
      run: playSelection,
    })
    ctx.add(Command, {
      id: "read-aloud.stop",
      get title() {
        return ctx.t("read-aloud.command.stop")
      },
      run: stop,
    })
    ctx.add(Command, {
      id: "read-aloud.open",
      get title() {
        return ctx.t("read-aloud.command.open")
      },
      run: openPanel,
    })

    ctx.add(Slot, {
      at: "session.header",
      order: 35,
      render: (props: HeaderProps) => (
        <Show when={props.active}>
          <button
            type="button"
            class="ra-header-button"
            title={ctx.t("read-aloud.action.play")}
            aria-label={ctx.t("read-aloud.action.play")}
            onClick={() => {
              if (playingId() === "latest" && audio && !audio.paused) stop()
              else if (busyId() !== "latest") playLatest(props.session)
            }}
            style={{
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              height: "24px",
              padding: "0 6px",
              background: "transparent",
              border: "none",
              "border-radius": "4px",
              cursor: "pointer",
              color:
                playingId() === "latest" || busyId() === "latest" ? "var(--color-text-interactive-base, inherit)" : "inherit",
            }}
          >
            <Icon name={busyId() === "latest" ? "refresh" : playingId() === "latest" ? "stop" : "waveform"} size="small" />
          </button>
        </Show>
      ),
    })

    // ---------- selection context menu ----------
    // The host does not let plugins add entries to its own right-click menu, so we
    // watch right-clicks over a text selection inside a message ([data-message-id])
    // and show our own small menu at the cursor instead of the host's.
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <SelectionMenu />,
    })

    const tab = {
      id: "replies",
      get title() {
        return ctx.t("read-aloud.panel.title")
      },
      icon: "waveform" as const,
      closable: "hover" as const,
      fallback: true,
    }

    ctx.add(Panel, {
      id: "read-aloud",
      region: "side",
      list: () => [tab],
      render: (props: PanelPropsLike) => <PanelView host={props} />,
    })

    function PanelView(props: { host: PanelPropsLike }) {
      const [replies, { refetch }] = createResource(
        () => props.host.session?.id,
        async (id) => {
          if (!id) return []
          const result = (await rpc.replies({ sessionID: id })) as { replies: ReplyItem[] }
          return result.replies ?? []
        },
      )
      const items = () => (replies() ?? []) as ReplyItem[]
      return (
        <div class="ra-panel" style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "13px" }}>
          <div
            class="ra-toolbar"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              padding: "6px 8px",
              "border-bottom": "1px solid var(--color-border-weak, rgba(128,128,128,0.25))",
            }}
          >
            <Show when={props.host.session}>
              <span style={{ "margin-right": "auto", opacity: 0.7 }}>{ctx.t("read-aloud.reply-count", { count: String(items().length) })}</span>
            </Show>
            <Show when={!props.host.session}>
              <span style={{ "margin-right": "auto", opacity: 0.7 }}>{ctx.t("read-aloud.no-session")}</span>
            </Show>
            <ToolButton title={ctx.t("read-aloud.action.refresh")} icon="refresh" onClick={() => void refetch()} />
            <Show when={playingId() || busyId()}>
              <ToolButton title={ctx.t("read-aloud.action.stop")} icon="stop" onClick={stop} />
            </Show>
            <ToolButton title={ctx.t("read-aloud.action.settings")} icon="settings-gear" onClick={() => ctx.layout.settings(ctx.id)} />
          </div>
          <div style={{ flex: "1", "overflow-y": "auto", padding: "4px" }}>
            <Show when={!replies.loading && items().length === 0}>
              <p style={{ padding: "12px 8px", opacity: 0.6 }}>{ctx.t("read-aloud.empty")}</p>
            </Show>
            <For each={items()}>
              {(item) => {
                const isPlaying = () => playingId() === item.id
                const isBusy = () => busyId() === item.id
                return (
                  <div
                    class="ra-item"
                    style={{ display: "flex", "align-items": "flex-start", gap: "6px", padding: "4px", "border-radius": "6px" }}
                  >
                    <button
                      type="button"
                      title={ctx.t("read-aloud.action.play-item")}
                      aria-label={ctx.t("read-aloud.action.play-item")}
                      onClick={() => {
                        if (isPlaying() && audio && !audio.paused) stop()
                        else if (!isBusy()) void play({ text: item.text }, item.id)
                      }}
                      style={{
                        flex: "none",
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        width: "24px",
                        height: "24px",
                        background: isPlaying() || isBusy() ? "var(--color-background-interactive, rgba(128,128,128,0.2))" : "transparent",
                        border: "1px solid var(--color-border-weak, rgba(128,128,128,0.25))",
                        "border-radius": "4px",
                        cursor: "pointer",
                        color: "inherit",
                      }}
                    >
                      <Icon name={isBusy() ? "refresh" : isPlaying() ? "stop" : "outline-audio"} size="small" />
                    </button>
                    <span style={{ "line-height": "1.5", "user-select": "text" }} title={item.preview}>
                      {item.preview}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      )
    }

    function ToolButton(props: { title: string; icon: string; onClick: () => void }) {
      return (
        <button
          type="button"
          title={props.title}
          aria-label={props.title}
          onClick={props.onClick}
          style={{
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "24px",
            height: "24px",
            background: "transparent",
            border: "none",
            "border-radius": "4px",
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <Icon name={props.icon} size="small" />
        </button>
      )
    }

    /** Dark or light colours for the floating menu, judged from the window background. */
    const menuPalette = () => {
      const bg = getComputedStyle(document.body).backgroundColor
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/.exec(bg)
      let dark = true
      if (rgb) dark = (Number(rgb[1]) * 299 + Number(rgb[2]) * 587 + Number(rgb[3]) * 114) / 1000 < 128
      return dark
        ? { background: "#26262b", color: "#e9e9ea", border: "1px solid rgba(255,255,255,0.14)", hover: "rgba(255,255,255,0.10)" }
        : { background: "#ffffff", color: "#232326", border: "1px solid rgba(0,0,0,0.18)", hover: "rgba(0,0,0,0.06)" }
    }

    function SelectionMenu(): JSX.Element {
      const [menu, setMenu] = createSignal<{ x: number; y: number; text: string; dark: boolean } | null>(null)
      let el: HTMLDivElement | undefined

      const close = () => setMenu(null)

      const onContextMenu = (event: MouseEvent) => {
        if (event.defaultPrevented) return
        if (el && event.target instanceof Node && el.contains(event.target)) return
        let inMessage = false
        let inEditor = false
        for (const node of event.composedPath()) {
          if (!(node instanceof Element)) continue
          if (!inMessage && node.hasAttribute("data-message-id")) inMessage = true
          if (!inEditor && (node.tagName === "TEXTAREA" || node.tagName === "INPUT" || (node instanceof HTMLElement && node.isContentEditable))) inEditor = true
          if (inMessage && inEditor) break
        }
        if (!inMessage || inEditor) return
        const text = window.getSelection()?.toString().trim() ?? ""
        if (!text) return
        event.preventDefault()
        event.stopPropagation()
        setMenu({
          x: Math.max(4, Math.min(event.clientX, window.innerWidth - 280)),
          y: Math.max(4, Math.min(event.clientY, window.innerHeight - 120)),
          text,
          dark: menuPalette().background === "#26262b",
        })
      }

      const onPointerDown = (event: PointerEvent) => {
        if (menu() && el && event.target instanceof Node && !el.contains(event.target)) close()
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (menu() && event.key === "Escape") close()
      }
      const onScroll = () => {
        if (menu()) close()
      }
      window.addEventListener("contextmenu", onContextMenu, true)
      window.addEventListener("pointerdown", onPointerDown, true)
      window.addEventListener("keydown", onKeyDown, true)
      window.addEventListener("scroll", onScroll, true)
      window.addEventListener("blur", close)
      onCleanup(() => {
        window.removeEventListener("contextmenu", onContextMenu, true)
        window.removeEventListener("pointerdown", onPointerDown, true)
        window.removeEventListener("keydown", onKeyDown, true)
        window.removeEventListener("scroll", onScroll, true)
        window.removeEventListener("blur", close)
      })

      return (
        <Show when={menu()}>
          {(entry) => {
            const palette = menuPalette()
            const preview = entry().text.replace(/\s+/g, " ")
            return (
              <Portal mount={document.body}>
                <div
                  ref={el}
                  role="menu"
                  style={{
                    position: "fixed",
                    left: `${entry().x}px`,
                    top: `${entry().y}px`,
                    "z-index": "2147483647",
                    "min-width": "200px",
                    "max-width": "270px",
                    background: palette.background,
                    color: palette.color,
                    border: palette.border,
                    "border-radius": "8px",
                    padding: "4px",
                    "box-shadow": "0 10px 28px rgba(0,0,0,0.45)",
                    "font-size": "13px",
                    "font-family": "system-ui, sans-serif",
                    "user-select": "none",
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <div style={{ padding: "4px 8px 6px", opacity: "0.55", "white-space": "nowrap", "text-overflow": "ellipsis", overflow: "hidden" }}>
                    {preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}
                  </div>
                  <MenuRow
                    label={ctx.t("read-aloud.context.read")}
                    hover={palette.hover}
                    onClick={() => {
                      const text = entry().text
                      close()
                      void play({ text }, "selection")
                    }}
                  />
                  <MenuRow
                    label={ctx.t("read-aloud.context.stop")}
                    hover={palette.hover}
                    onClick={() => {
                      close()
                      stop()
                    }}
                  />
                </div>
              </Portal>
            )
          }}
        </Show>
      )
    }

    function MenuRow(props: { label: string; hover: string; onClick: () => void }) {
      return (
        <button
          type="button"
          role="menuitem"
          onClick={props.onClick}
          onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={(event) => (event.currentTarget.style.background = props.hover)}
          onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
          style={{
            display: "block",
            width: "100%",
            "text-align": "left",
            background: "transparent",
            border: "none",
            "border-radius": "5px",
            color: "inherit",
            "font-size": "13px",
            "font-family": "inherit",
            padding: "6px 8px",
            cursor: "pointer",
          }}
        >
          {props.label}
        </button>
      )
    }

    ctx.add(SettingsPage, {
      id: "read-aloud",
      get title() {
        return ctx.t("read-aloud.settings.title")
      },
      icon: "outline-audio",
      render: () => <SettingsView />,
    })

    function SettingsView() {
      const list = () => (voices().length > 0 ? voices() : [{ id: DEFAULT_PREFS.voice, label: DEFAULT_PREFS.voice }])
      return (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "4px 0", "font-size": "13px" }}>
          <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span>{ctx.t("read-aloud.settings.voice")}</span>
            <select
              value={prefs().voice}
              onChange={(event) => void savePrefs({ voice: event.currentTarget.value })}
              style={{ "align-self": "flex-start", padding: "4px 8px", "min-width": "240px" }}
            >
              <For each={list()}>
                {(voice) => <option value={voice.id}>{voice.label}</option>}
              </For>
            </select>
          </label>
          <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span>
              {ctx.t("read-aloud.settings.rate")} — {rateLabel(prefs().rate)}
            </span>
            <input
              type="range"
              min={-50}
              max={50}
              step={5}
              value={prefs().rate}
              onInput={(event) => void savePrefs({ rate: Number(event.currentTarget.value) })}
              style={{ "align-self": "flex-start", width: "240px" }}
            />
          </label>
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().autoPlay}
              onChange={(event) => void savePrefs({ autoPlay: event.currentTarget.checked })}
            />
            <span>{ctx.t("read-aloud.settings.auto-play")}</span>
          </label>
        </div>
      )
    }
  },
})
