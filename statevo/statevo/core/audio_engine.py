"""
Recording + playback engine.

Design goals:
  * Never block the audio callback thread — it only pushes into a queue.
  * Write recordings to disk incrementally (a writer thread drains the
    queue) so a 45-minute take doesn't have to sit entirely in RAM.
  * Keep this MVP simple: playback renders a buffer up front and plays
    it via sounddevice's own playback thread. A true streaming, live-
    mixing playback engine (so edits are audible without a re-render)
    is the natural next step and slots in here without touching the UI
    layer — see ARCHITECTURE.md, "Playback engine upgrade path".

Threading note: `last_peak_level` is a plain float updated from the
writer thread and read from the Qt main thread via a QTimer poll. That
single-float read/write is safe under the GIL. Do NOT call Qt widget
methods directly from `on_level` or any other engine callback — those
fire on background threads, and Qt widgets may only be touched from
the main/GUI thread.
"""
from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import sounddevice as sd
import soundfile as sf

from statevo.config import DEFAULT_BIT_DEPTH, DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE
from statevo.core.dsp_utils import db_to_gain


class AudioEngine:
    def __init__(self, sample_rate: int = DEFAULT_SAMPLE_RATE, channels: int = DEFAULT_CHANNELS):
        self.sample_rate = sample_rate
        self.channels = channels
        self.input_device: Optional[int] = None
        self.output_device: Optional[int] = None

        self.input_gain_db: float = 0.0
        self.last_peak_level: float = 0.0  # linear 0..~1, poll this from a UI timer

        self._record_stream: Optional[sd.InputStream] = None
        self._record_queue: "queue.Queue[np.ndarray]" = queue.Queue()
        self._writer_thread: Optional[threading.Thread] = None
        self._writing = False
        self._current_take_path: Optional[Path] = None
        self._recorded_frames = 0
        self._on_level: Optional[Callable[[float], None]] = None
        self._record_started_at = 0.0

    # -- device discovery -----------------------------------------------

    @staticmethod
    def list_input_devices() -> list[dict]:
        devices = sd.query_devices()
        return [
            {"index": i, "name": d["name"], "max_input_channels": d["max_input_channels"]}
            for i, d in enumerate(devices) if d["max_input_channels"] > 0
        ]

    def set_input_device(self, index: Optional[int]) -> None:
        self.input_device = index

    # -- recording ---------------------------------------------------------

    def start_recording(self, target_path: Path, on_level: Optional[Callable[[float], None]] = None) -> None:
        """Begin recording to `target_path`. `on_level`, if given, fires
        from a background thread — see the module docstring's threading
        note before using it for anything beyond non-UI bookkeeping."""
        if self._writing:
            raise RuntimeError("Already recording.")

        self._current_take_path = target_path
        self._on_level = on_level
        self._recorded_frames = 0
        self._writing = True
        self._record_started_at = time.monotonic()

        target_path.parent.mkdir(parents=True, exist_ok=True)

        def audio_callback(indata: np.ndarray, frames: int, time_info, status) -> None:
            if status:
                pass  # overflows etc. — don't raise inside the audio callback
            gained = indata * db_to_gain(self.input_gain_db)
            self._record_queue.put(gained.astype(np.float32, copy=False))

        self._record_stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            device=self.input_device,
            dtype="float32",
            callback=audio_callback,
        )
        self._record_stream.start()

        self._writer_thread = threading.Thread(target=self._writer_loop, daemon=True)
        self._writer_thread.start()

    def _writer_loop(self) -> None:
        assert self._current_take_path is not None
        with sf.SoundFile(
            str(self._current_take_path), mode="w",
            samplerate=self.sample_rate, channels=self.channels,
            subtype=DEFAULT_BIT_DEPTH,
        ) as f:
            while self._writing or not self._record_queue.empty():
                try:
                    block = self._record_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                f.write(block)
                self._recorded_frames += len(block)

                peak = float(np.max(np.abs(block))) if block.size else 0.0
                self.last_peak_level = peak
                if self._on_level is not None:
                    self._on_level(peak)

    def stop_recording(self) -> tuple[Path, float]:
        if not self._writing:
            raise RuntimeError("Not recording.")
        self._writing = False
        if self._record_stream is not None:
            self._record_stream.stop()
            self._record_stream.close()
            self._record_stream = None
        if self._writer_thread is not None:
            self._writer_thread.join(timeout=5.0)
            self._writer_thread = None

        duration = self._recorded_frames / float(self.sample_rate)
        path = self._current_take_path
        self._current_take_path = None
        self.last_peak_level = 0.0
        assert path is not None
        return path, duration

    @property
    def is_recording(self) -> bool:
        return self._writing

    @property
    def elapsed_recording_sec(self) -> float:
        if not self._writing:
            return 0.0
        return time.monotonic() - self._record_started_at

    # -- playback -------------------------------------------------------------

    def play_buffer(self, audio: np.ndarray, sr: Optional[int] = None) -> None:
        sd.play(audio, samplerate=sr or self.sample_rate, device=self.output_device)

    def stop_playback(self) -> None:
        sd.stop()

    def is_playing(self) -> bool:
        stream = sd.get_stream()
        return stream is not None and stream.active
