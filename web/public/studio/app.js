"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const TOGGLES = [
  ["captions", "Captions"], ["hook_text", "Hook text"], ["remove_fillers", "Cut filler words & silences"],
  ["cold_open", "Cold opens"], ["zoom", "Zoom punch-ins"], ["emoji", "Emoji"], ["progress_bar", "Progress bar"],
];
const FILLER_RE = /^(um+|uh+|erm|er|ah|hmm|uhm|mm)[.,!?]*$/i;
let META = null;
let viewTimer = null;

// Klips Studio runs on klips.pro; the work happens in Klips Engine on this computer.
// `api` talks to the engine, `site` talks to klips.pro (signed in with the browser's session cookie).
const ENGINE_PORTS = [47813, 47814, 47815, 47816, 47817];
let ENGINE = "";
let ACCOUNT = null;

const eng = (path) => `${ENGINE}${path}`;

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function api(url, opts = {}) {
  return readJson(await fetch(eng(url), opts));
}

async function site(url, opts = {}) {
  const headers = opts.body ? { "Content-Type": "application/json", ...(opts.headers || {}) } : opts.headers;
  return readJson(await fetch(url, { ...opts, headers, credentials: "same-origin" }));
}

function toast(message, ms = 3200) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function fillSelect(select, items, value) {
  select.innerHTML = "";
  for (const item of items) select.add(new Option(item.label, item.id));
  if (value !== undefined) select.value = value;
}

function renderToggles(container, values) {
  container.innerHTML = "";
  for (const [key, label] of TOGGLES) {
    const wrap = el("label", "check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = key;
    input.checked = values[key] !== false;
    wrap.append(input, document.createTextNode(label));
    container.append(wrap);
  }
}

// ---------- routing ----------

function route() {
  clearTimeout(viewTimer);
  const match = location.hash.match(/^#\/job\/([\w-]+)/);
  $("#view-home").hidden = !!match;
  $("#view-job").hidden = !match;
  if (match) showJob(match[1]);
  else showHome();
}

// ---------- home ----------

async function showHome() {
  try {
    const jobs = await api("/api/jobs");
    const list = $("#jobs");
    list.innerHTML = "";
    if (!jobs.length) list.append(el("div", "empty", "No projects yet. Upload a video above to get started."));
    for (const job of jobs) {
      const card = el("a", "job-card");
      card.href = `#/job/${job.id}`;
      card.append(el("div", "name", job.filename), el("span", `pill ${job.status}`, job.status));
      const when = new Date(job.created * 1000).toLocaleString();
      card.append(el("div", "muted small", `${job.stage} · ${when}`));
      list.append(card);
    }
    if (jobs.some((j) => j.status === "running" || j.status === "queued")) viewTimer = setTimeout(showHome, 3000);
  } catch (e) {
    toast(e.message);
  }
}

const VIDEO_RE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
// Zoom names its separate webcam file "..._Recording_as_..." (active speaker) or "..._avo_..." (active speaker video only).
const FACECAM_RE = /(_as_|_avo_|active.?speaker|speaker|webcam|facecam|camera)/i;

function setupUpload() {
  const form = $("#new-job");
  const input = $("#video-input");
  const camInput = $("#speaker-input");
  const setFile = (el, file) => {
    const dt = new DataTransfer();
    if (file) dt.items.add(file);
    el.files = dt.files;
  };
  const size = (f) => (f.size >= 1e9 ? `${(f.size / 1e9).toFixed(1)} GB` : `${Math.round(f.size / 1e6)} MB`);
  const label = () => {
    const main = input.files[0];
    const cam = camInput.files[0];
    $("#drop-label").textContent = main ? `✓ ${main.name} · ${size(main)}` : "Drop a video here, or click to choose";
    $("#cam-label").textContent = cam ? `✓ ${cam.name} · ${size(cam)}` : "Drop the webcam video here, or click to choose";
    $("#drop").classList.toggle("filled", !!main);
    $("#drop-cam").classList.toggle("filled", !!cam);
    $("#swap-videos").hidden = !(main && cam);
    $("#cam-clear").hidden = !cam;
  };
  const addFiles = (files, target) => {
    const videos = [...files].filter((f) => f.type.startsWith("video/") || VIDEO_RE.test(f.name));
    if (!videos.length) return toast("Please choose video files (MP4, MOV, MKV or WebM).");
    if (videos.length >= 2) {
      let cam = videos.find((f) => FACECAM_RE.test(f.name));
      let main = videos.find((f) => f !== cam);
      if (!cam) [main, cam] = videos;
      setFile(input, main);
      setFile(camInput, cam);
      toast("Added both videos. If the facecam is in the wrong slot, press Swap videos.", 5000);
    } else {
      setFile(target, videos[0]);
    }
    label();
  };
  for (const [zone, target] of [[$("#drop"), input], [$("#drop-cam"), camInput]]) {
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, () => zone.classList.remove("over")));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, target);
    });
  }
  input.addEventListener("change", () => (input.files.length > 1 ? addFiles(input.files, input) : label()));
  camInput.addEventListener("change", label);
  $("#swap-videos").addEventListener("click", () => {
    const main = input.files[0];
    setFile(input, camInput.files[0]);
    setFile(camInput, main);
    label();
  });
  $("#cam-clear").addEventListener("click", () => { setFile(camInput, null); label(); });
  label();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!input.files[0]) return toast("Add your meeting recording in box 1 first.");
    if (!LICENSE.activated) return toast("Still connecting Klips Engine to your account. Try again in a moment.", 6000);
    if (CLAUDE && CLAUDE.backend === "claude-code" && !CLAUDE.ready) {
      return toast("Connect Claude Code first (the steps at the top).", 6000);
    }
    if (selectedPlan() === "free") {
      if (!ACCOUNT || (ACCOUNT.free_clips_left ?? 0) <= 0) {
        return toast(`You've used today's free clips. Choose Tokens, or come back at ${resetTime()}.`, 7000);
      }
    } else {
      const needed = tokenCost($("#new-job").clips.value);
      if (needed > LICENSE.tokens) {
        return toast(`That needs ${needed} tokens and you have ${LICENSE.tokens}. Buy more on your account page, or choose Free.`, 7000);
      }
    }
    const button = $("#submit-job");
    const status = $("#upload-status");
    button.disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", eng("/api/jobs"));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) status.textContent = `Uploading ${Math.round((ev.loaded / ev.total) * 100)}%`; };
    xhr.onload = () => {
      button.disabled = false;
      status.textContent = "";
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      if (xhr.status !== 200) return toast(data.error || "Upload failed");
      const plan = selectedPlan();
      form.reset();
      form.querySelector(`input[name="plan"][value="${plan}"]`).checked = true;
      renderToggles($("#home-toggles"), META.defaults);
      label();
      location.hash = `#/job/${data.id}`;
      setTimeout(refreshTokens, 4000); // tokens or free clips are reserved once the clips are planned
      setTimeout(refreshTokens, 60000);
    };
    xhr.onerror = () => { button.disabled = false; status.textContent = ""; toast("Upload failed. Is Klips Engine still running?", 6000); };
    xhr.send(new FormData(form));
  });
}

// ---------- job view ----------

let currentJob = null;

async function showJob(id) {
  let job;
  try {
    job = await api(`/api/jobs/${id}`);
  } catch (e) {
    toast("Project not found");
    location.hash = "#/";
    return;
  }
  currentJob = job;
  $("#job-title").textContent = job.filename;
  $("#job-stage").textContent = job.status === "error" ? `Failed: ${job.error}` : `${job.stage}${job.status === "running" ? ` · ${Math.round(job.progress * 100)}%` : ""}`;
  $("#job-progress").style.width = `${Math.round(job.progress * 100)}%`;
  const log = $("#job-log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = job.log.join("\n");
  if (atBottom) log.scrollTop = log.scrollHeight;

  const anyDone = job.clips.some((c) => c.status === "done");
  $("#job-export").hidden = !anyDone;
  $("#job-export").href = eng(`/api/jobs/${id}/export.zip`);
  $("#job-retry").hidden = !(job.status === "error" || job.clips.some((c) => c.status === "error"));
  renderClips(job);

  if (editor.open && editor.job && editor.job.id === id) editor.sync(job);
  const busy = job.status === "running" || job.status === "queued" || job.clips.some((c) => c.status === "queued" || c.status === "rendering");
  if (location.hash === `#/job/${id}`) viewTimer = setTimeout(() => showJob(id), busy ? 1500 : 6000);
}

function renderClips(job) {
  const grid = $("#clips");
  if (!job.clips.length) {
    grid.innerHTML = "";
    const msg = job.status === "error" ? "No clips were made." : "Clips will appear here as they're found and rendered.";
    grid.append(el("div", "empty", msg));
    return;
  }
  if (grid.querySelector(".empty")) grid.innerHTML = "";
  for (const clip of job.clips) {
    let card = grid.querySelector(`[data-idx="${clip.idx}"]`);
    if (!card) {
      card = el("div", "clip");
      card.dataset.idx = clip.idx;
      card.innerHTML = '<div class="thumb"><span class="badge"></span><div class="state"></div></div><div class="meta"><h4></h4><div class="muted small info"></div></div>';
      card.addEventListener("click", () => editor.show(currentJob, currentJob.clips.find((c) => c.idx === clip.idx)));
      grid.append(card);
    }
    const thumb = card.querySelector(".thumb");
    const thumbUrl = clip.thumb ? `url("${eng(`/media/${job.id}/${encodeURIComponent(clip.thumb)}`)}?v=${clip.version}")` : "";
    if (thumb.dataset.bg !== thumbUrl) { thumb.style.backgroundImage = thumbUrl; thumb.dataset.bg = thumbUrl; }
    card.querySelector(".badge").textContent = clip.virality_score;
    card.querySelector("h4").textContent = clip.title;
    const bits = [];
    if (job.options.watermark && !clip.watermark_removed) bits.push("watermarked");
    if (clip.duration) bits.push(`${Math.round(clip.duration)}s`);
    if (clip.layouts) bits.push(clip.layouts.join(" + "));
    card.querySelector(".info").textContent = bits.join(" · ") || `${fmtTime(clip.start)} – ${fmtTime(clip.end)}`;
    const state = card.querySelector(".state");
    state.innerHTML = "";
    if (clip.status !== "done") {
      state.append(el("span", `pill ${clip.status}`, clip.status === "error" ? "failed" : clip.status));
      if (clip.status === "rendering") {
        const bar = el("div", "mini-progress");
        const fill = el("div");
        fill.style.width = `${Math.round(clip.progress * 100)}%`;
        bar.append(fill);
        state.append(bar);
      }
    }
  }
}

function setupJobActions() {
  $("#job-delete").addEventListener("click", async () => {
    if (!currentJob || !confirm(`Delete "${currentJob.filename}" and all its clips?`)) return;
    try {
      await api(`/api/jobs/${currentJob.id}`, { method: "DELETE" });
      location.hash = "#/";
    } catch (e) { toast(e.message); }
  });
  $("#job-retry").addEventListener("click", async () => {
    try {
      await api(`/api/jobs/${currentJob.id}/retry`, { method: "POST" });
      toast("Retrying…");
      refreshTokens();
      showJob(currentJob.id);
    } catch (e) {
      toast(e.message, 6000);
    }
  });
}

// ---------- clip editor ----------

const editor = {
  open: false, job: null, clip: null, words: [], peaks: [], deleted: new Set(),
  start: 0, end: 0, winStart: 0, winEnd: 0, drag: null, dirty: false, seenVersion: 0,

  async show(job, clip) {
    if (!clip) return;
    Object.assign(this, { job, clip, open: true, dirty: false, drag: null, seenVersion: clip.version || 0 });
    this.deleted = new Set(clip.deleted || []);
    this.start = clip.start;
    this.end = clip.end;
    this.winStart = Math.max(0, clip.start - 15);
    this.winEnd = clip.end + 15;
    const opts = { ...job.options, ...(clip.overrides || {}) };

    $("#editor").showModal();
    $("#ed-title").value = clip.title;
    $("#ed-hook").value = clip.hook;
    $("#ed-score").textContent = clip.virality_score;
    $("#ed-reason").textContent = clip.reason || "";
    const breakdown = $("#ed-breakdown");
    breakdown.innerHTML = "";
    for (const [key, value] of Object.entries(clip.scores || {})) {
      const bar = el("div", "bar", `${key[0].toUpperCase()}${key.slice(1)} ${value}`);
      const track = el("div");
      const fill = el("i");
      fill.style.width = `${value}%`;
      track.append(fill);
      bar.append(track);
      breakdown.append(bar);
    }
    fillSelect($("#ed-platform"), META.platforms.map((p) => ({ id: p.id, label: p.label })), opts.platform);
    fillSelect($("#ed-preset"), META.presets, opts.caption_preset);
    renderToggles($("#ed-toggles"), opts);
    this.renderPost();
    this.loadVideo();
    this.setDirty(false);

    const [words, peaks] = await Promise.all([
      api(`/api/jobs/${job.id}/transcript?start=${this.winStart}&end=${this.winEnd}`),
      api(`/api/jobs/${job.id}/waveform?start=${this.winStart}&end=${this.winEnd}&points=900`),
    ]);
    if (this.clip !== clip) return;
    this.words = words;
    this.peaks = peaks;
    const src = $("#ed-source");
    if (!src.src) src.src = eng(`/api/jobs/${job.id}/source`);
    this.renderWords();
    this.draw();
    this.syncBusy(clip);
  },

  renderWatermark() {
    const { job, clip } = this;
    const button = $("#ed-unwatermark");
    button.hidden = !(job.options.watermark && !clip.watermark_removed && clip.status === "done");
  },

  async removeWatermark() {
    const button = $("#ed-unwatermark");
    if (LICENSE.tokens < 3) {
      toast("Removing a watermark takes 3 tokens. Buy tokens on your account page.", 6000);
      return;
    }
    button.disabled = true;
    try {
      this.clip = await api(`/api/jobs/${this.job.id}/clips/${this.clip.idx}/remove-watermark`, { method: "POST" });
      this.syncBusy(this.clip);
      this.renderWatermark();
      toast("Removing the watermark. The clip re-renders in a moment.");
      refreshTokens();
      showJob(this.job.id);
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      button.disabled = false;
    }
  },

  loadVideo() {
    const { job, clip } = this;
    this.renderWatermark();
    const video = $("#ed-video");
    const platform = (clip.overrides && clip.overrides.platform) || job.options.platform;
    $("#ed-phone").classList.toggle("landscape45", platform === "linkedin");
    if (clip.file) {
      const url = eng(`/media/${job.id}/${encodeURIComponent(clip.file)}?v=${clip.version}`);
      video.src = url;
      $("#ed-download").href = `${url}&download=1`;
      $("#ed-download").setAttribute("download", clip.file);
      $("#ed-download").hidden = false;
    } else {
      video.removeAttribute("src");
      $("#ed-download").hidden = true;
    }
  },

  renderPost() {
    const post = this.clip.post || {};
    const box = $("#ed-post");
    box.innerHTML = "";
    const items = [
      ["Title", this.clip.post_title || post.title || this.clip.title],
      ["Description (with link and hashtags)", this.clip.description_full || post.description],
      ["Hashtags", (post.hashtags || []).join(" ")],
      ["TikTok / Reels caption", post.tiktok_caption],
      ["YouTube Shorts title", post.shorts_title],
    ];
    for (const [label, text] of items) {
      if (!text) continue;
      const item = el("div", "post-item");
      const copy = el("button", "ghost small", "Copy");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(text);
        toast("Copied");
      });
      const body = el("div", "", text);
      body.style.whiteSpace = "pre-wrap";
      item.append(el("b", "", label), body, copy);
      box.append(item);
    }
  },

  renderWords() {
    const box = $("#ed-words");
    box.innerHTML = "";
    const emph = new Set(this.clip.emphasis || []);
    const cold = this.clip.cold_open;
    for (const w of this.words) {
      if (w.start < this.start - 0.05 || w.end > this.end + 0.05) continue;
      const span = el("span", "", w.text);
      if (this.deleted.has(w.i)) span.classList.add("cut");
      if (FILLER_RE.test(w.text)) span.classList.add("filler");
      if (emph.has(w.i)) span.classList.add("emph");
      if (cold && w.i >= cold[0] && w.i <= cold[1]) span.classList.add("cold");
      span.title = fmtTime(w.start);
      span.addEventListener("click", () => {
        if (this.deleted.has(w.i)) this.deleted.delete(w.i);
        else this.deleted.add(w.i);
        span.classList.toggle("cut");
        this.setDirty(true);
      });
      box.append(span, document.createTextNode(" "));
    }
    $("#ed-range").textContent = `${fmtTime(this.start)} – ${fmtTime(this.end)} · ${(this.end - this.start).toFixed(1)}s before cuts`;
  },

  toX(t, width) { return ((t - this.winStart) / (this.winEnd - this.winStart)) * width; },
  toT(x, width) { return this.winStart + (x / width) * (this.winEnd - this.winStart); },

  draw(playhead) {
    const canvas = $("#ed-wave");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const x0 = this.toX(this.start, w);
    const x1 = this.toX(this.end, w);
    ctx.fillStyle = "rgba(255,212,0,0.08)";
    ctx.fillRect(x0, 0, x1 - x0, h);
    const n = this.peaks.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const amp = Math.max(1, this.peaks[i] * (h - 16));
      ctx.fillStyle = x >= x0 && x <= x1 ? "#d9d9e3" : "#4a4a57";
      ctx.fillRect(x, (h - amp) / 2, Math.max(1, w / n - 0.5), amp);
    }
    ctx.fillStyle = "#ff5c5c";
    for (const word of this.words) {
      if (this.deleted.has(word.i) && word.start >= this.start && word.end <= this.end) {
        const a = this.toX(word.start, w);
        ctx.fillRect(a, h - 5, Math.max(2, this.toX(word.end, w) - a), 3);
      }
    }
    ctx.fillStyle = "#ffd400";
    for (const x of [x0, x1]) {
      ctx.fillRect(x - 3, 0, 6, h);
      ctx.beginPath();
      ctx.arc(x, h / 2, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (playhead !== undefined) {
      ctx.fillStyle = "#00e5ff";
      ctx.fillRect(this.toX(playhead, w) - 1, 0, 2, h);
    }
  },

  setupTimeline() {
    const canvas = $("#ed-wave");
    const pos = (e) => e.clientX - canvas.getBoundingClientRect().left;
    canvas.addEventListener("pointerdown", (e) => {
      const w = canvas.clientWidth;
      const x = pos(e);
      const d0 = Math.abs(x - this.toX(this.start, w));
      const d1 = Math.abs(x - this.toX(this.end, w));
      if (Math.min(d0, d1) > 14) return;
      this.drag = d0 <= d1 ? "start" : "end";
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const t = Math.min(this.winEnd, Math.max(this.winStart, this.toT(pos(e), canvas.clientWidth)));
      if (this.drag === "start") this.start = Math.min(t, this.end - 3);
      else this.end = Math.max(t, this.start + 3);
      this.draw();
    });
    const release = () => {
      if (!this.drag) return;
      // snap to the nearest word boundary
      if (this.words.length) {
        if (this.drag === "start") this.start = this.words.reduce((b, w) => (Math.abs(w.start - this.start) < Math.abs(b - this.start) ? w.start : b), this.words[0].start);
        else this.end = this.words.reduce((b, w) => (Math.abs(w.end - this.end) < Math.abs(b - this.end) ? w.end : b), this.words[0].end);
      }
      this.drag = null;
      this.draw();
      this.renderWords();
      this.setDirty(true);
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    window.addEventListener("resize", () => this.open && this.draw());

    const src = $("#ed-source");
    $("#ed-play-src").addEventListener("click", () => {
      if (!src.paused) { src.pause(); return; }
      $("#ed-video").pause();
      src.currentTime = this.start;
      src.play();
    });
    src.addEventListener("timeupdate", () => {
      if (src.currentTime >= this.end) src.pause();
      this.draw(src.currentTime);
    });
    src.addEventListener("play", () => ($("#ed-play-src").textContent = "❚❚ Pause"));
    src.addEventListener("pause", () => ($("#ed-play-src").textContent = "▶ Play selection"));
  },

  setDirty(value) {
    this.dirty = value;
    $("#ed-dirty").textContent = value ? "Unsaved changes" : "";
  },

  collect() {
    const overrides = { platform: $("#ed-platform").value, caption_preset: $("#ed-preset").value };
    for (const input of $("#ed-toggles").querySelectorAll("input")) overrides[input.name] = input.checked;
    return {
      title: $("#ed-title").value, hook: $("#ed-hook").value, deleted: [...this.deleted],
      start: this.start, end: this.end, overrides,
    };
  },

  async render() {
    const button = $("#ed-render");
    button.disabled = true;
    try {
      const clip = await api(`/api/jobs/${this.job.id}/clips/${this.clip.idx}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.collect()),
      });
      this.clip = clip;
      this.setDirty(false);
      this.syncBusy(clip);
      showJob(this.job.id);
    } catch (e) {
      toast(e.message);
    } finally {
      button.disabled = false;
    }
  },

  syncBusy(clip) {
    const busy = clip.status === "queued" || clip.status === "rendering";
    $("#ed-busy").hidden = !busy;
    $("#ed-busy-text").textContent = clip.status === "queued" ? "Queued…" : `Rendering ${Math.round((clip.progress || 0) * 100)}%`;
    $("#ed-render").disabled = busy;
  },

  sync(job) {
    const fresh = job.clips.find((c) => c.idx === this.clip.idx);
    if (!fresh) return;
    this.job = job;
    const wasBusy = this.clip.status === "queued" || this.clip.status === "rendering";
    this.clip = { ...fresh };
    this.syncBusy(fresh);
    this.renderWatermark();
    if (fresh.status === "done" && (fresh.version || 0) !== this.seenVersion) {
      this.seenVersion = fresh.version || 0;
      this.loadVideo();
      if (wasBusy) toast("Clip re-rendered");
    }
    if (fresh.status === "error" && wasBusy) toast(`Render failed: ${fresh.error}`, 6000);
  },

  close() {
    this.open = false;
    $("#ed-video").pause();
    $("#ed-source").pause();
    $("#ed-source").removeAttribute("src");
    $("#ed-source").load();
    $("#editor").close();
  },
};

function setupEditor() {
  editor.setupTimeline();
  $("#ed-close").addEventListener("click", () => editor.close());
  $("#editor").addEventListener("cancel", (e) => { e.preventDefault(); editor.close(); });
  $("#ed-render").addEventListener("click", () => editor.render());
  $("#ed-unwatermark").addEventListener("click", () => editor.removeWatermark());
  for (const id of ["#ed-title", "#ed-hook", "#ed-platform", "#ed-preset", "#ed-toggles"]) {
    $(id).addEventListener("change", () => editor.setDirty(true));
    $(id).addEventListener("input", () => editor.setDirty(true));
  }
}

// ---------- brand kit ----------

function setupBrand() {
  const dialog = $("#brand");
  const form = $("#brand-form");
  $("#open-brand").addEventListener("click", async () => {
    const brand = await api("/api/brand");
    form.reset();
    form.font.value = brand.font || "";
    form.primary.value = brand.primary || "#ffffff";
    form.accent.value = brand.accent || "#ffd400";
    form.cta.value = brand.cta || "";
    form.link_url.value = brand.link_url || "";
    form.link_text.value = brand.link_text || "";
    const preview = $("#brand-logo");
    preview.innerHTML = "";
    if (brand.has_logo) {
      const img = document.createElement("img");
      img.src = eng(`/api/brand/logo?t=${Date.now()}`);
      preview.append(img);
    }
    dialog.showModal();
  });
  $("#brand-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/brand", { method: "POST", body: new FormData(form) });
      dialog.close();
      toast("Brand kit saved. Re-render clips to apply it.");
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- licence and tokens ----------

let LICENSE = { activated: false, tokens: 0, clips_available: 0, tokens_per_clip: 3, email: "" };

function tokenCost(clips) {
  return Math.max(0, Number(clips) || 0) * (LICENSE.tokens_per_clip || 3);
}

function renderLicense() {
  const chip = $("#token-chip");
  chip.hidden = !ACCOUNT;
  if (ACCOUNT) {
    chip.textContent = `${LICENSE.tokens.toLocaleString()} tokens`;
    chip.title = `${ACCOUNT.email} · buy tokens or see your history`;
  }
  updateCostLine();
}

const FREE_PLAN_KEY = "klips.plan";

function selectedPlan() {
  const checked = document.querySelector('#new-job input[name="plan"]:checked');
  return checked ? checked.value : "tokens";
}

function resetTime() {
  if (!ACCOUNT || !ACCOUNT.free_resets_at) return "midnight UTC";
  return new Date(ACCOUNT.free_resets_at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Pick Free or Tokens: remember the customer's choice, otherwise use tokens when they have enough. */
function renderPlanChoice() {
  const form = $("#new-job");
  const freeLeft = ACCOUNT ? ACCOUNT.free_clips_left ?? 0 : 0;
  const perDay = ACCOUNT ? ACCOUNT.free_clips_per_day || 10 : 10;
  $("#plan-free-text").textContent = freeLeft > 0
    ? `${freeLeft} of ${perDay} free clips left today · klips.pro watermark`
    : `Today's ${perDay} free clips are used · more at ${resetTime()}`;
  $("#plan-free-text").closest(".plan-option").classList.toggle("empty", freeLeft <= 0);
  $("#plan-tokens-text").textContent = `No watermark · 3 tokens a clip · ${LICENSE.tokens.toLocaleString()} tokens`;
  if (!form.querySelector('input[name="plan"]:checked')) {
    let saved = "";
    try { saved = localStorage.getItem(FREE_PLAN_KEY) || ""; } catch { /* storage blocked */ }
    const clips = Number(form.clips.value) || 0;
    const plan = saved || (LICENSE.tokens >= tokenCost(clips) ? "tokens" : "free");
    const input = form.querySelector(`input[name="plan"][value="${plan}"]`);
    if (input) input.checked = true;
  }
}

function updateCostLine() {
  const line = $("#token-cost");
  if (!line) return;
  const clips = Number($("#new-job").clips.value) || 0;
  const cost = tokenCost(clips);
  if (!LICENSE.activated) {
    line.textContent = "Connecting Klips Engine to your account…";
    line.classList.remove("short");
    return;
  }
  renderPlanChoice();
  if (selectedPlan() === "free") {
    const freeLeft = ACCOUNT ? ACCOUNT.free_clips_left ?? 0 : 0;
    const short = freeLeft <= 0;
    line.textContent = short
      ? `No free clips left today. Use tokens, or come back at ${resetTime()}.`
      : clips > freeLeft
        ? `Free plan: your top ${freeLeft} of ${clips} clips, with a klips.pro watermark`
        : `Free plan: ${clips} clips with a klips.pro watermark`;
    line.classList.toggle("short", short);
    return;
  }
  const short = cost > LICENSE.tokens;
  line.textContent = short
    ? `${clips} clips need ${cost} tokens — you have ${LICENSE.tokens}. Buy more on your account page, or choose Free.`
    : `${clips} clips = ${cost} tokens · ${LICENSE.tokens.toLocaleString()} available`;
  line.classList.toggle("short", short);
}

/** The token balance lives on klips.pro; refresh it from there. */
async function refreshTokens() {
  try {
    const me = await site("/api/auth/me");
    if (!me.signed_in) {
      location.href = `/login?next=${encodeURIComponent("/studio/")}`;
      return;
    }
    ACCOUNT = me;
    LICENSE.tokens = me.tokens || 0;
  } catch {
    /* offline for a moment; keep the last known balance */
  }
  renderLicense();
}

/** Make sure the engine on this computer uses the account signed in here. */
async function linkEngine() {
  const info = await api("/api/engine");
  if (info.linked && info.account === ACCOUNT.email) {
    try {
      LICENSE = await api("/api/license/refresh", { method: "POST" });
    } catch {
      LICENSE = await api("/api/license");
    }
    return;
  }
  const { app_key } = await site("/api/engine/link", { method: "POST", body: "{}" });
  LICENSE = await api("/api/license/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_key }),
  });
}

function setupLicense() {
  const form = $("#new-job");
  form.clips.addEventListener("input", updateCostLine);
  for (const input of form.querySelectorAll('input[name="plan"]')) {
    input.addEventListener("change", () => {
      try { localStorage.setItem(FREE_PLAN_KEY, input.value); } catch { /* storage blocked */ }
      updateCostLine();
    });
  }
}

// ---------- Klips Engine connection ----------

async function probeEngine() {
  const override = new URLSearchParams(location.search).get("engine");
  const bases = override ? [override.replace(/\/$/, "")] : ENGINE_PORTS.map((port) => `http://127.0.0.1:${port}`);
  // One port at a time: the engine almost always has the first, and a closed port fails instantly.
  for (const base of bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${base}/api/engine`, { signal: controller.signal });
      const info = await res.json();
      if (info.app === "klips-engine") return { base, info };
    } catch {
      /* not on this port */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function localAccessBlocked() {
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const status = await navigator.permissions.query({ name });
      return status.state === "denied";
    } catch {
      /* this browser doesn't know that permission name */
    }
  }
  return false;
}

async function showEngineMissing(stopped) {
  $("#boot").hidden = true;
  $("#studio").hidden = true;
  $("#engine-missing").hidden = false;
  $("#open-brand").hidden = true;
  const chip = $("#engine-chip");
  chip.hidden = !stopped;
  chip.classList.add("off");
  chip.querySelector("span").textContent = "Engine stopped";
  $("#engine-missing-title").textContent = stopped
    ? "Klips Engine stopped"
    : "Start Klips Engine on this computer";
  const ua = navigator.userAgent;
  const windows = /Windows/i.test(ua);
  $("#engine-open-hint").textContent = windows
    ? "Open Klips from the Start menu. It starts the engine and keeps it running in the background."
    : "Open Klips from your Applications folder. It starts the engine and keeps it running in the background.";
  const primary = $("#engine-download-primary");
  const secondary = $("#engine-download-secondary");
  primary.href = windows ? "/download/windows" : "/download/mac";
  primary.textContent = windows ? "Download for Windows" : "Download for Mac";
  secondary.href = windows ? "/download/mac" : "/download/windows";
  secondary.textContent = windows ? "Download for Mac" : "Download for Windows";
  const note = $("#engine-browser-note");
  if (await localAccessBlocked()) {
    note.textContent = "Your browser is blocking klips.pro from connecting to Klips Engine. Click the icon to the left of the web address, open Site settings, set Local network access to Allow, then reload this page.";
    note.classList.add("blocked");
  } else if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) {
    note.textContent = "Safari may block the connection to Klips Engine. If this page doesn't connect after you open Klips, use Chrome or Edge.";
  }
}

/** Wait until the engine answers, showing install help meanwhile. */
async function connectEngine(stopped = false) {
  for (let attempt = 0; ; attempt++) {
    const found = await probeEngine();
    if (found) {
      ENGINE = found.base;
      $("#engine-missing").hidden = true;
      const chip = $("#engine-chip");
      chip.hidden = false;
      chip.classList.remove("off");
      chip.querySelector("span").textContent = `Engine ${found.info.version}`;
      return found.info;
    }
    if (attempt === 1 || stopped) showEngineMissing(stopped);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

const versionParts = (v) => String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
function isOlder(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

function setupEngineChip() {
  $("#engine-chip").addEventListener("click", async () => {
    if ($("#engine-chip").classList.contains("off")) return;
    if (!confirm("Quit Klips Engine on this computer? Clips that are being made will stop. Open the Klips app to start it again.")) return;
    try {
      await api("/api/engine/quit", { method: "POST" });
      toast("Klips Engine is quitting");
    } catch (e) {
      toast(e.message);
    }
  });
}

async function checkForUpdate(info) {
  try {
    const latest = await site("/api/engine/latest");
    if (!latest.version || !isOlder(info.version, latest.version)) return;
    $("#engine-update").hidden = false;
    $("#engine-update-text").textContent = `You have ${info.version}; version ${latest.version} is available.`;
    $("#engine-update-link").href = info.platform === "windows" ? "/download/windows" : "/download/mac";
  } catch {
    /* not important enough to interrupt anyone */
  }
}

/** Notice if the engine is closed while the studio is open, and reconnect when it's back. */
function watchEngine() {
  let failures = 0;
  const tick = async () => {
    try {
      const res = await fetch(eng("/api/engine"));
      if (!res.ok) throw new Error();
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= 2) {
        await connectEngine(true);
        failures = 0;
        await linkEngine().catch(() => undefined);
        $("#studio").hidden = false;
        $("#open-brand").hidden = false;
        route();
      }
    }
    setTimeout(tick, 8000);
  };
  setTimeout(tick, 8000);
}

// ---------- Claude Code setup ----------

let CLAUDE = null;
let claudePoll = null;

function renderClaude(status) {
  CLAUDE = status;
  const box = $("#cc-setup");
  if (status.backend !== "claude-code" || status.ready) {
    if (!box.hidden && status.ready) toast("Claude Code is connected. You're ready to make clips.", 5000);
    box.hidden = true;
    clearInterval(claudePoll);
    claudePoll = null;
    return;
  }
  box.hidden = false;
  const windows = status.platform === "windows";
  $("#cc-shell").textContent = windows ? "PowerShell (search for it in the Start menu)" : "Terminal";
  $("#cc-command").textContent = status.install_command;

  const install = status.install || {};
  const installing = install.state === "running";
  const stepInstall = $("#cc-step-install");
  const stepLogin = $("#cc-step-login");
  stepInstall.classList.toggle("done", status.installed);
  stepLogin.classList.toggle("waiting", !status.installed);

  const button = $("#cc-install");
  button.hidden = status.installed;
  button.disabled = installing;
  button.innerHTML = installing ? '<span class="spinner-inline"></span>Installing…' : (install.state === "failed" ? "Try again" : "Install Claude Code");
  $("#cc-install-text").textContent = status.installed
    ? "Installed."
    : installing
      ? "Installing with Anthropic's official installer. Keep this tab open."
      : install.error || "Free to install. It takes about a minute.";
  const log = $("#cc-install-log");
  log.hidden = !(installing || install.state === "failed") || !install.log;
  log.textContent = install.log || "";
  log.scrollTop = log.scrollHeight;
  $(".setup-manual").hidden = status.installed;

  $("#cc-login").disabled = !status.installed;

  // Keep checking while setup is on screen, so it completes without a reload.
  if (!claudePoll) claudePoll = setInterval(refreshClaude, installing ? 2000 : 4000);
}

async function refreshClaude() {
  try {
    renderClaude(await api("/api/claude/status"));
  } catch {
    /* the local server is busy; try on the next tick */
  }
}

function setupClaude(initial) {
  $("#cc-install").addEventListener("click", async () => {
    try {
      renderClaude(await api("/api/claude/install", { method: "POST" }));
    } catch (err) {
      toast(err.message, 6000);
    }
  });
  $("#cc-login").addEventListener("click", async () => {
    try {
      await api("/api/claude/sign-in", { method: "POST" });
      $("#cc-login-hint").textContent = "Finish signing in in the window that opened. This updates by itself.";
    } catch (err) {
      const shell = CLAUDE && CLAUDE.platform === "windows" ? "PowerShell" : "Terminal";
      $("#cc-login-hint").textContent = `Couldn't open the sign-in window. Open ${shell} yourself and run: claude auth login`;
      toast(err.message, 7000);
    }
  });
  $("#cc-recheck").addEventListener("click", async () => {
    $("#cc-recheck").disabled = true;
    await refreshClaude();
    $("#cc-recheck").disabled = false;
    if (CLAUDE && !CLAUDE.ready) toast(CLAUDE.message || "Not connected yet.", 4000);
  });
  $("#cc-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#cc-command").textContent);
      toast("Copied");
    } catch {
      toast("Select the command and copy it.");
    }
  });
  renderClaude(initial);
}

// ---------- boot ----------

(async function init() {
  await refreshTokens();
  if (!ACCOUNT) return;
  const info = await connectEngine();
  $("#boot-text").textContent = "Connecting Klips Engine to your account…";
  $("#boot").hidden = false;
  try {
    await linkEngine();
  } catch (e) {
    $("#boot-text").textContent = `Couldn't connect Klips Engine to your account: ${e.message} Reload to try again.`;
    return;
  }
  META = await api("/api/meta");
  LICENSE = { ...META.klips, tokens: ACCOUNT.tokens || 0 };
  $("#boot").hidden = true;
  $("#studio").hidden = false;
  $("#open-brand").hidden = false;
  checkForUpdate(info);
  setupEngineChip();
  watchEngine();
  setInterval(refreshTokens, 20000);
  $("#key-warning").hidden = META.llm.backend !== "api" || META.llm.ready;
  setupClaude(META.llm);
  $("#key-warning").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings/api-key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: $("#key-input").value }),
      });
      $("#key-input").value = "";
      $("#key-warning").hidden = true;
      toast("API key saved. You're ready to make clips.");
    } catch (err) {
      toast(err.message, 5000);
    }
  });
  fillSelect($("#platform-select"), META.platforms.map((p) => ({ id: p.id, label: p.label })), META.defaults.platform);
  fillSelect($("#preset-select"), META.presets, META.defaults.caption_preset);
  renderToggles($("#home-toggles"), META.defaults);
  const fontSelect = $("#brand-font");
  for (const f of META.fonts) fontSelect.add(new Option(f, f));
  setupUpload();
  setupJobActions();
  setupEditor();
  setupBrand();
  setupLicense();
  renderLicense();
  window.addEventListener("hashchange", route);
  route();
})();
