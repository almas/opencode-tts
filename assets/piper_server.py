#!/usr/bin/env python3
"""
opencode-tts resident Piper server.

The plugin spawns this file with `python3 piper_server.py --port 0 --models A,B`
and talks to it over loopback HTTP. Keeping one process alive removes the
~0.6 s model load (and ~0.2 s interpreter start) from every phrase: synthesis
of a short reply then takes tens of milliseconds instead of over a second, and
answers stream sentence by sentence so playback can start before the whole
text is done.

Protocol (all requests need the header `X-Tts-Token: <token>` given at start):
  GET  /health          -> {"ok": true, "loaded": [...paths]}
  POST /synth           -> body {"model": path, "speaker": int|null,
                                 "lengthScale": float, "volume": float,
                                 "text": str}
                           response: audio/wav, PCM16 mono, streamed;
                           X-Tts-Sample-Rate header carries the rate
  OPTIONS *             -> CORS preflight for the webview

On stdout it prints one line `READY {"port": N}` once listening, exits after
`--idle` seconds without a request, and never logs request bodies.
"""

import argparse
import json
import math
import os
import re
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_TEXT = 20000


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, token: str, models: list[str], idle_seconds: float):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token
        self.idle_seconds = idle_seconds
        self.last_request = time.monotonic()
        self.voices = {}
        self.lock = threading.Lock()
        from piper import PiperVoice

        for path in models:
            try:
                self.voices[path] = PiperVoice.load(path)
                self.prewarm(self.voices[path])
            except Exception as error:  # noqa: BLE001 — report and keep the rest
                print(f"WARN failed to load {path}: {error}", flush=True)

    @staticmethod
    def prewarm(voice) -> None:
        """Synthesize one syllable so the model's first run is warm.

        ONNX Runtime's first inference on a freshly loaded model is several
        times slower than later runs (graph optimisation, allocator and page
        cache warm-up). Without this the first streamed phrase synthesises
        slower than real time and playback stutters until the model catches
        up; one throwaway syllable per model moves that cost to start-up.
        """
        try:
            from piper import SynthesisConfig

            for _ in voice.synthesize("あ", SynthesisConfig()):
                pass
        except Exception as error:  # noqa: BLE001 — a cold model is still usable
            print(f"WARN prewarm failed: {error}", flush=True)

    def voice(self, model: str):
        """Return a loaded voice, loading the model on first use if needed."""
        with self.lock:
            voice = self.voices.get(model)
            if voice is None:
                from piper import PiperVoice

                voice = PiperVoice.load(model)
                self.prewarm(voice)
                self.voices[model] = voice
            return voice

    def touch(self) -> None:
        self.last_request = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: Server

    def _cors(self) -> None:
        # The webview is served from another loopback port, so it needs an
        # explicit pass; the token header is the actual gate.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tts-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Without this the webview's fetch cannot read the sample-rate header
        # and silently falls back to 22050, which plays other rates wrong.
        self.send_header("Access-Control-Expose-Headers", "X-Tts-Sample-Rate")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("X-Tts-Token") == self.server.token

    def do_OPTIONS(self) -> None:  # noqa: N802 — stdlib naming
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self.server.touch()
        if self.path != "/health":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        self._json(200, {"ok": True, "loaded": sorted(self.server.voices)})

    def do_POST(self) -> None:  # noqa: N802
        self.server.touch()
        if self.path != "/synth":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            text = str(request.get("text") or "").strip()[:MAX_TEXT]
            if not text:
                self._json(400, {"error": "empty text"})
                return
            voice = self.server.voice(str(request.get("model") or ""))
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": str(error)})
            return

        from piper import SynthesisConfig

        speaker = request.get("speaker")
        config = SynthesisConfig(
            speaker_id=int(speaker) if speaker is not None else None,
            length_scale=float(request.get("lengthScale") or 1.0),
            volume=float(request.get("volume") or 1.0),
        )
        sample_rate = int(voice.config.sample_rate)
        try:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("X-Tts-Sample-Rate", str(sample_rate))
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            # A streaming WAV: sizes stay 0xFFFFFFFF, which Chromium and
            # decodeAudioData accept; the chunked framing ends the file.
            header = wav_header(sample_rate)
            self.wfile.write(b"%x\r\n" % len(header) + header + b"\r\n")
            for chunk in voice.synthesize(text, config):
                pcm = chunk.audio_int16_bytes
                self.wfile.write(b"%x\r\n" % len(pcm) + pcm + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client moved on to the next phrase; nothing to report
        except Exception as error:  # noqa: BLE001
            print(f"WARN synth failed: {error}", flush=True)

    def log_message(self, *args) -> None:
        pass  # the request line would carry the endpoint only; keep it quiet


def wav_header(sample_rate: int) -> bytes:
    byte_rate = sample_rate * 2
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, 2, 16
    ) + b"data" + struct.pack("<I", 0xFFFFFFFF)


def main() -> int:
    parser = argparse.ArgumentParser(description="resident piper audio server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    parser.add_argument("--models", default="", help="comma separated .onnx paths")
    parser.add_argument("--idle", type=float, default=600.0, help="quit after this many idle seconds")
    args = parser.parse_args()

    models = [p for p in re.split(r"[,\s]+", args.models.strip()) if p]
    try:
        server = Server(args.port, args.token, models, args.idle)
    except Exception as error:  # noqa: BLE001 — the caller probes and falls back
        print(f"FATAL {error}", flush=True)
        return 1

    def watchdog() -> None:
        while True:
            time.sleep(5)
            if time.monotonic() - server.last_request > server.idle_seconds:
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    print(f"READY {json.dumps({'port': server.server_address[1]})}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
