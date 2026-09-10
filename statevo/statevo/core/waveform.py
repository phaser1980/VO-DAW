"""
Waveform peak caching.

Rendering a full-resolution waveform for a 20-minute take on every paint
event would be absurd. Instead we compute a single high-resolution
"peaks" array once per take (min/max pairs over small fixed-size sample
windows) and let the UI further downsample that cached array on the fly
for whatever zoom level it's currently drawing at.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import soundfile as sf

PEAKS_PER_SECOND = 100  # resolution of the cached peak data — plenty for any UI zoom.


@dataclass
class PeakData:
    mins: np.ndarray   # shape (n,), float32, one value per bucket
    maxs: np.ndarray   # shape (n,), float32
    sample_rate: int
    peaks_per_second: int = PEAKS_PER_SECOND

    def slice_for_view(self, start_sec: float, end_sec: float, target_width_px: int):
        """Downsample the cached peaks to roughly one min/max pair per
        pixel for the given [start_sec, end_sec) window within the take.
        Returns (mins, maxs) as numpy arrays of length <= target_width_px."""
        start_idx = max(0, int(start_sec * self.peaks_per_second))
        end_idx = min(len(self.mins), int(end_sec * self.peaks_per_second))
        if end_idx <= start_idx:
            return np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32)

        window_mins = self.mins[start_idx:end_idx]
        window_maxs = self.maxs[start_idx:end_idx]
        if target_width_px <= 0 or len(window_mins) <= target_width_px:
            return window_mins, window_maxs

        # Further bucket down to ~one column per pixel.
        bucket_edges = np.linspace(0, len(window_mins), target_width_px + 1).astype(int)
        out_mins = np.empty(target_width_px, dtype=np.float32)
        out_maxs = np.empty(target_width_px, dtype=np.float32)
        for i in range(target_width_px):
            lo, hi = bucket_edges[i], max(bucket_edges[i] + 1, bucket_edges[i + 1])
            out_mins[i] = window_mins[lo:hi].min()
            out_maxs[i] = window_maxs[lo:hi].max()
        return out_mins, out_maxs


def generate_peaks(file_path: str, peaks_per_second: int = PEAKS_PER_SECOND) -> PeakData:
    """Read a take's audio file and compute a min/max peak cache.

    Streams the file in chunks (rather than loading it whole) so this
    stays cheap even for a long recording.
    """
    with sf.SoundFile(file_path) as f:
        sr = f.samplerate
        samples_per_bucket = max(1, int(sr / peaks_per_second))
        read_chunk_buckets = 2048
        chunk_frames = samples_per_bucket * read_chunk_buckets

        mins_list: list[np.ndarray] = []
        maxs_list: list[np.ndarray] = []
        tail = np.zeros(0, dtype=np.float32)

        while True:
            block = f.read(frames=chunk_frames, dtype="float32", always_2d=True)
            if block.size == 0:
                break
            mono = block.mean(axis=1)
            mono = np.concatenate([tail, mono]) if tail.size else mono

            n_buckets = len(mono) // samples_per_bucket
            usable = n_buckets * samples_per_bucket
            if n_buckets:
                reshaped = mono[:usable].reshape(n_buckets, samples_per_bucket)
                mins_list.append(reshaped.min(axis=1))
                maxs_list.append(reshaped.max(axis=1))
            tail = mono[usable:]

        if tail.size:
            mins_list.append(np.array([tail.min()], dtype=np.float32))
            maxs_list.append(np.array([tail.max()], dtype=np.float32))

    mins_arr = np.concatenate(mins_list) if mins_list else np.zeros(0, dtype=np.float32)
    maxs_arr = np.concatenate(maxs_list) if maxs_list else np.zeros(0, dtype=np.float32)
    return PeakData(mins=mins_arr, maxs=maxs_arr, sample_rate=sr, peaks_per_second=peaks_per_second)
