"""Word-level transcription. Uses mlx-whisper on Apple Silicon when installed, else faster-whisper."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, List, Optional

_MLX_REPOS = {
    "tiny": "mlx-community/whisper-tiny", "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx", "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


def _clean(words) -> List[dict]:
    out = []
    for start, end, text in words:
        text = text.strip()
        if text:
            out.append({"start": round(float(start), 2), "end": round(float(end), 2), "text": text})
    return out


def transcribe(audio_path: Path, model_size: str = "small", language: Optional[str] = None,
               duration: float = 0.0, progress: Callable[[float], None] = lambda p: None) -> List[dict]:
    try:
        import mlx_whisper  # optional: `pip install mlx-whisper`
    except ImportError:
        mlx_whisper = None

    if mlx_whisper is not None:
        result = mlx_whisper.transcribe(str(audio_path), path_or_hf_repo=_MLX_REPOS.get(model_size, model_size),
                                        word_timestamps=True, language=language)
        progress(1.0)
        return _clean((w["start"], w["end"], w["word"]) for s in result["segments"] for w in s.get("words", []))

    from faster_whisper import BatchedInferencePipeline, WhisperModel

    model = WhisperModel(model_size, device="auto", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    # Batched mode transcribes several speech chunks at once (voice detection is built in): much faster on a laptop CPU.
    batched = BatchedInferencePipeline(model=model)
    segments, info = batched.transcribe(str(audio_path), batch_size=8, word_timestamps=True, language=language)
    total = duration or info.duration or 1.0
    raw = []
    for seg in segments:
        raw.extend((w.start, w.end, w.word) for w in seg.words or [])
        progress(min(1.0, seg.end / total))
    return _clean(raw)
