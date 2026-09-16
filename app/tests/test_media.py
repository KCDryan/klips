import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clipper import media  # noqa: E402
from clipper.config import ffmpeg_exe  # noqa: E402


def test_extract_audio_keeps_a_delayed_audio_start():
    """Recordings whose audio track starts late (common with separate Zoom files) must keep that gap,
    otherwise transcripts and webcam sync drift by the delay."""
    tmp = Path(tempfile.mkdtemp())
    video = tmp / "delayed.mp4"
    subprocess.run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=4",
                    "-itsoffset", "1.0", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)],
                   check=True)
    wav = tmp / "out.wav"
    media.extract_audio(video, wav)
    audio = media.load_audio(wav)
    first_sound = int(np.argmax(np.abs(audio) > 0.05)) / media.SAMPLE_RATE
    assert 0.9 <= first_sound <= 1.1
