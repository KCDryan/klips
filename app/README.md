# AI Clipper

Turn long videos (podcasts, interviews, webinars, Zoom calls) into ready-to-post vertical shorts, similar to CapCut's "Long video to shorts" or Opus Clip.

## What it does

**Finding moments (Claude)**
- Scans the transcript for self-contained moments with a strong hook and a clear payoff. Videos over 90 minutes are split into overlapping chapters, then every candidate is re-ranked together and near-duplicates are dropped.
- Scores each clip on hook, payoff, clarity and emotion.
- Optional "Find clips about…" topic filter.
- Writes an optimized title, description and hashtags for each clip, plus a TikTok caption and a Shorts title. Your link (set in Brand kit) is added to every description.
- Marks power words for emphasis, adds emoji, and picks a cold open line when the best moment comes a few seconds in.

**Editing**
- Cuts on word boundaries. When a clip runs long, it ends at the last full sentence that fits.
- Removes "um"/"uh"/"you know," and silences over 0.4s, with short audio fades at every cut.
- Cold opens: the strongest line plays first, then the clip starts.
- Alternating 1.06x zoom on jump cuts to hide them, and 1.12x punch-ins on emphasized words (at most one every 6s).

**Framing**
- Face tracking (MediaPipe) with a smoothed virtual camera.
- Active-speaker detection: mouth movement is matched against audio, and head movement is ignored.
- Two-person crosstalk gets a stacked split-screen. Otherwise it cuts between speakers at sentence boundaries.
- Detects scene cuts so the camera never pans across one.
- With no face (screen recordings, B-roll), it shows the full frame over a blurred background.

**Zoom / Meet / Teams screen shares**
- Screen-share moments switch automatically to a stacked layout: the shared screen on top, and the webcam across the bottom 28% with captions at the top of the webcam area. Moments with only the facecam keep the normal framing.
- **Sharp webcam option:** in Zoom, turn on *Settings → Recording → "Record active speaker, gallery view and shared screen separately"*. Upload the shared-screen (or full-view) recording as the main video, and the *active speaker* file as the **Webcam recording**. The app lines the two up by matching their audio, then uses the full-quality webcam file during screen shares.
- Without the separate file, the webcam is taken from the small tile inside the recording, then enlarged and sharpened.
- To change the webcam's share of the frame, edit `CAM_FRACTION` in `clipper/screenshare.py`.

**Style**
- 5 caption styles: Bold Pop, Bold Box, Minimal, Karaoke Fill, Neon Glow. They include emphasis colors and emoji.
- Captions and overlays stay out of each platform's UI zones.
- Brand kit: logo watermark, colors, caption font, end-screen call to action, and the link added to descriptions.
- Optional background music, automatically ducked under speech. Loudness is normalized to -14 LUFS.
- Progress bar and hook title.

**App**
- Upload page with progress for each stage. Jobs are stored in SQLite, so they survive restarts.
- Clip editor:
  - Waveform timeline with draggable in/out handles
  - Clickable transcript to cut words
  - Caption style and platform pickers
  - Post copy with copy buttons
  - Re-render of just that clip
- Export presets: TikTok, Reels, Shorts (1080×1920) and LinkedIn (1080×1350). The ZIP export includes every clip, a copy sheet next to each clip, and a combined `post_copy.txt`.
- Uses Apple's hardware H.264 encoder when available, otherwise libx264.

## Set up on any computer (Mac or Windows)

You need:
1. **Python 3.10, 3.11 or 3.12** from https://www.python.org/downloads/. On Windows, tick **"Add python.exe to PATH"** in the installer. Python 3.13 won't work yet, because MediaPipe doesn't support it.
2. **Claude Code**, signed in with your Claude Pro/Max account. The app uses it to pick clips and write post copy, so no API key is needed. Install it from https://code.claude.com/docs/en/setup, then run `claude` once and log in.

Then open the `ai-clipper` folder:
- **Windows:** double-click `start.bat`.
- **Mac:** double-click `start.command`. If macOS blocks it, right-click it and choose **Open**.

The first run installs everything into a `.venv` folder, which takes a few minutes. After that it starts straight away and opens http://localhost:5055. Close the window to stop the app.

No ffmpeg or Homebrew install is needed: ffmpeg comes bundled with the `imageio-ffmpeg` package. On first use, Whisper downloads its speech model (~500 MB for the default).

### Working in VS Code

1. **File → Open Folder…** and pick `ai-clipper`.
2. Run `start.bat` or `./start.command` once in the VS Code terminal to create `.venv`.
3. Press ⌘⇧P / Ctrl+Shift+P, choose **Python: Select Interpreter**, and pick the one inside `.venv`.
4. Start the app from the terminal:
   - Mac: `.venv/bin/python app.py`
   - Windows: `.venv\Scripts\python app.py`

To use an API key instead of Claude Code, set `CLIPPER_LLM=api` before starting, then paste the key into the box at the top of the page.

## Command line

```bash
.venv/bin/python -m clipper my_podcast.mp4 --clips 8 --captions box --platform reels --topic "money mistakes"
.venv/bin/python -m clipper zoom_shared_screen.mp4 --speaker zoom_active_speaker.mp4
```

Run `.venv/bin/python -m clipper --help` for every option. On Windows, use `.venv\Scripts\python`.

## Notes

- **Fonts.** Captions use fonts built into macOS, with Windows and Linux equivalents (Segoe, Bahnschrift, DejaVu). To use a brand font, drop any `.ttf`/`.otf` into a `fonts/` folder and it appears in the Brand kit.
- **Speed.** Transcription takes about 5-15 minutes for an hour of video on a modern laptop CPU. Rendering is roughly realtime per clip. On Apple Silicon, `pip install mlx-whisper` speeds up transcription.
- **Claude usage.** A normal video uses 2-3 Claude requests, which count toward your subscription's usage limits.
- **Your data.** Projects live in `data/`. Brand kit settings and projects don't copy over automatically; bring the `data/` folder along if you want them on the new computer.
- **Tests.** Run `.venv/bin/python -m pytest tests`.
- **Rights.** Only clip videos you own or have permission to use.

## Layout

```
app.py               web app (Flask)
start.command        Mac/Linux one-click setup and start
start.bat            Windows one-click setup and start
static/              editor UI
clipper/
  transcribe.py      Whisper word timestamps
  picker.py          Claude: candidates, re-rank, packaging (Claude Code or API)
  postcopy.py        titles, descriptions with your link, hashtags
  edit.py            snapping, filler/silence cuts, cold opens, output timeline
  reframe.py         faces, active speaker, scene cuts, layouts
  screenshare.py     Zoom screen-share detection and stacked layout
  speaker.py         separate webcam recording: audio sync and face tracking
  captions.py        caption styles, hook, CTA, logo
  render.py          frame compositing, zooms, audio mix, encode
  pipeline.py        stages, caching, re-renders, background worker
  store.py           SQLite jobs, clips, brand kit
  __main__.py        command line
tests/               unit tests
data/                your projects (created on first run)
```
