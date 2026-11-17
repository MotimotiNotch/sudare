// Sudare の画面。状態は1つの `side`（サイドカー mosaic.json の中身）に持ち、変えたら描き直して保存する。
//
// 枠の座標はすべて原寸の画素で持つ。表示用の縮小画像（preview）とは k = 縮小の幅 / 原寸の幅 で行き来する。

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { startTour, tourIfFirst, tourOpen } from "./tour";

type Box = { x: number; y: number; w: number; h: number };
type Face = Box & { score: number };
type Photo = {
  detected: Face[] | null; // null = まだ探していない
  off: number[]; // 外した検出枠の番号（0 始まり）
  added: (Box & { off?: boolean })[];
  candidates?: Face[]; // 確度の低い検出（0.3〜0.6、見つけた顔の範囲の外）。かけずに「候補」として見せる
  picked?: number[]; // かけることにした候補の番号
  cells: number;
  checked: boolean;
  exported: string | null; // 書き出したときの指定（sig）。今の指定と違えば書き出し直しが要る
};
type Sidecar = { version: 1; detector: string; photos: Record<string, Photo> };

// 検出の条件が変わったら探し直す（Rust の detect.rs と合わせる）
const DETECTOR = "yunet-2023mar score0.6 cand0.3 max4000 nms0.3";
const SURE = 0.6; // これ以上は見つけた顔（最初からかかる）、未満は候補
const PAD = 0.35; // 検出枠は頬・髪まで広げる
const DEFAULT_CELLS = 8;
const PREVIEW_SIDE = 3200;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>("view");
const ctx = view.getContext("2d")!;

let folder = "";
let names: string[] = [];
let side: Sidecar = { version: 1, detector: DETECTOR, photos: {} };
let tab: "faces" | "none" = "faces";
let shown: string[] = []; // 下パネルに今出している群（探し終えた写真だけ）
let current: string | null = null;
let mode: "add" | "remove" = "add";
let shift = false;

const thumbs = new Map<string, string>(); // name -> data URL
const cropCache = new Map<string, string>(); // `${name}|${x},${y},${w},${h}` -> data URL

// 開いている写真の表示
let img: HTMLImageElement | null = null;
let full = { w: 1, h: 1 };
const composite = document.createElement("canvas"); // 縮小画像＋モザイク
let zoom = { s: 1, ox: 0, oy: 0 };

// ---------- 状態 ----------

function photo(name: string): Photo {
  return (side.photos[name] ??= { detected: null, off: [], added: [], cells: DEFAULT_CELLS, checked: false, exported: null });
}

/** 枠の一覧（検出→手で足した順）。番号は画面に出す 1 始まり */
type Item = { box: Box; kind: "detected" | "added" | "candidate"; on: boolean; index: number; label: string };
function items(p: Photo): Item[] {
  const out: Item[] = [];
  (p.detected ?? []).forEach((f, i) => out.push({ box: f, kind: "detected", on: !p.off.includes(i), index: i, label: String(i + 1) }));
  p.added.forEach((b, i) => out.push({ box: b, kind: "added", on: !b.off, index: i, label: `+${i + 1}` }));
  // 候補の番号は見つけた顔の続き（かけたら見つけた顔と同じ赤で出る）
  const n = p.detected?.length ?? 0;
  (p.candidates ?? []).forEach((f, i) => out.push({ box: f, kind: "candidate", on: (p.picked ?? []).includes(i), index: i, label: String(n + i + 1) }));
  return out;
}

function regions(p: Photo) {
  return items(p)
    .filter((it) => it.on)
    .map((it) => ({ ...pick(it.box), pad: it.kind === "added" ? 0 : PAD }));
}
const pick = (b: Box): Box => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function sig(p: Photo) {
  return JSON.stringify([regions(p), p.cells]);
}

/** f の中心が、b を pad だけ広げた範囲に入るか */
function inside(f: Box, b: Box, pad: number) {
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  return cx >= b.x - b.w * pad && cx <= b.x + b.w * (1 + pad) && cy >= b.y - b.h * pad && cy <= b.y + b.h * (1 + pad);
}

const hasFaces = (p: Photo) => (p.detected?.length ?? 0) > 0;

function toggle(it: Item) {
  const p = photo(current!);
  hover = null; // 押した切り抜きは別の段へ移って消えるので、mouseleave が来ない
  if (it.kind === "detected") {
    p.off = it.on ? [...p.off, it.index] : p.off.filter((i) => i !== it.index);
  } else if (it.kind === "candidate") {
    const picked = p.picked ?? [];
    p.picked = it.on ? picked.filter((i) => i !== it.index) : [...picked, it.index];
  } else {
    p.added[it.index]!.off = it.on;
  }
  changed();
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("save_sidecar", { folder, text: JSON.stringify(side, null, 1) }).catch((e) => status(`保存できません: ${e}`));
  }, 300);
}

function changed() {
  const p = photo(current!);
  if (regions(p).length > 0) p.checked = true;
  renderComposite();
  draw();
  renderFaces();
  renderStrip();
  save();
}

function status(text: string) {
  $("status").textContent = text;
}

/** ヘッダーの下の細い棒。done / total の割合だけを形で見せる（数は status の文字に出ている） */
function progress(done: number, total: number | null) {
  const bar = $("progress");
  bar.hidden = total === null;
  if (total !== null) bar.style.width = `${(100 * done) / Math.max(1, total)}%`;
}

/** 写真を開くときの札（文字だけ）。一瞬で済む読み込みでちらつかないよう、150ms 待ってから出す */
let busyTimer = 0;
function busy(text: string | null) {
  clearTimeout(busyTimer);
  const el = $("loading");
  if (text === null) {
    el.hidden = true;
    return;
  }
  busyTimer = window.setTimeout(() => {
    el.querySelector("span")!.textContent = text;
    el.hidden = false;
  }, 150);
}

// ---------- 窓全体を覆う幕: 進み具合の棒と、確かめの問い ----------

/** 進み具合の幕。frac は 0〜1。stop を渡すと「止める」を出す */
function showProgress(text: string, frac: number, stop?: () => void) {
  const m = $("modal");
  m.hidden = false;
  m.querySelector("h2")!.textContent = text;
  m.querySelector<HTMLElement>("p")!.hidden = true;
  const bar = m.querySelector<HTMLElement>(".bar")!;
  bar.hidden = false;
  bar.querySelector("i")!.style.width = `${Math.round(100 * Math.min(1, Math.max(0, frac)))}%`;
  const acts = m.querySelector<HTMLElement>(".actions")!;
  if (stop) {
    const b = document.createElement("button");
    b.textContent = "止める";
    b.onclick = () => {
      b.disabled = true;
      b.textContent = "この1枚が済んだら止めます";
      stop();
    };
    if (!acts.dataset.stop) acts.replaceChildren(b);
    acts.dataset.stop = "1";
  } else {
    acts.replaceChildren();
    delete acts.dataset.stop;
  }
}

function hideModal() {
  const m = $("modal");
  m.hidden = true;
  const acts = m.querySelector<HTMLElement>(".actions")!;
  acts.replaceChildren();
  delete acts.dataset.stop;
}

/** 確かめの問い。ok なら true */
function ask(title: string, body: string, ok: string, cancel: string): Promise<boolean> {
  const m = $("modal");
  m.hidden = false;
  m.querySelector("h2")!.textContent = title;
  const p = m.querySelector<HTMLElement>("p")!;
  p.hidden = false;
  p.textContent = body;
  m.querySelector<HTMLElement>(".bar")!.hidden = true;
  const acts = m.querySelector<HTMLElement>(".actions")!;
  delete acts.dataset.stop;
  return new Promise((resolve) => {
    const no = document.createElement("button");
    no.textContent = cancel;
    const yes = document.createElement("button");
    yes.textContent = ok;
    yes.className = "primary";
    no.onclick = () => (hideModal(), resolve(false));
    yes.onclick = () => (hideModal(), resolve(true));
    acts.replaceChildren(no, yes);
    yes.focus();
  });
}

// ---------- フォルダ ----------

async function openFolder() {
  if (running) return;
  const picked = await open({ directory: true });
  if (typeof picked !== "string") return;
  folder = picked;
  status("");
  $("folder").textContent = folder;
  const scan = await invoke<{ names: string[]; sidecar: string | null }>("scan", { folder });
  names = scan.names;
  side = { version: 1, detector: DETECTOR, photos: {} };
  if (scan.sidecar) {
    try {
      const s = JSON.parse(scan.sidecar) as Sidecar;
      if (s.version === 1) {
        side = s;
        if (s.detector !== DETECTOR) for (const p of Object.values(side.photos)) p.detected = null;
        side.detector = DETECTOR;
      }
    } catch {
      status("mosaic.json が読めないので、作り直します");
    }
  }
  thumbs.clear();
  cropCache.clear();
  current = null;
  img = null;
  $("empty").hidden = names.length > 0;
  if (names.length === 0) $("empty").textContent = "このフォルダの直下に JPG がありません。";
  renderStrip();
  renderFaces();
  draw();
  renderRun();
  if (names.length === 0) return;

  running = true;
  try {
    // 1. 写真を読み込む（縮小画像）
    for (const [i, name] of names.entries()) {
      showProgress(`写真を読み込んでいます（${i + 1} / ${names.length}）`, i / names.length);
      try {
        const pv = await invoke<{ url: string }>("preview", { folder, name, maxSide: 256 });
        thumbs.set(name, pv.url);
      } catch (e) {
        status(`${name}: ${e}`);
      }
      renderStrip();
    }
    hideModal();
  } finally {
    running = false;
  }
  await selectFirst();

  // 2. まだ探していない写真があれば、確かめてから一括でかける
  if (todo().length > 0) await runMosaic();

  // 3. 初めてなら、写真が並んだところで使い方を見せる
  tourIfFirst("photos");
}

const todo = () => names.filter((n) => photo(n).detected === null);

/** 今のタブの先頭の写真を開く（まだ探していない写真しか無ければ、それを開く） */
async function selectFirst() {
  if (current !== null) return;
  const first =
    names.find((n) => photo(n).detected !== null && (tab === "faces" ? hasFaces(photo(n)) : !hasFaces(photo(n)))) ??
    names.find((n) => photo(n).detected === null);
  if (first) await select(first);
}

let running = false;
async function runMosaic() {
  const list = todo();
  if (list.length === 0 || running) return;
  const ok = await ask(
    `フォルダ内の写真 ${list.length} 枚にモザイクを一括でかけますが、よろしいですか？`,
    "顔を探して、見つけた顔に全部モザイクをかけます。これには時間が掛かります。途中で止めても、済んだ分は残ります。",
    "かける",
    "あとで",
  );
  if (!ok) {
    renderRun();
    return;
  }
  const opened = folder;
  let stopped = false;
  running = true;
  renderRun();
  try {
    for (const [i, name] of list.entries()) {
      if (stopped || folder !== opened) break;
      // 最初の1枚は検出の準備（モデルの最適化）も入って数秒かかる
      showProgress(
        i === 0 ? `顔を探す準備をしています（1 / ${list.length}）` : `モザイクをかけています（${i + 1} / ${list.length}）`,
        i / list.length,
        () => (stopped = true),
      );
      const p = photo(name);
      try {
        const d = await invoke<{ faces: Face[] }>("detect_faces", { folder, name });
        const all = d.faces.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h), score: Math.round(f.score * 1000) / 1000 }));
        p.detected = all.filter((f) => f.score >= SURE);
        // 見つけた顔の範囲（頬・髪まで広げた分）に中心が入る候補は、もうかかっているので出さない
        p.candidates = all.filter((f) => f.score < SURE && !p.detected!.some((b) => inside(f, b, PAD)));
        p.picked = (p.picked ?? []).filter((i) => i < p.candidates!.length);
        p.checked = hasFaces(p);
        save();
      } catch (e) {
        status(`${name}: ${e}`);
        continue;
      }
      renderStrip();
    }
  } finally {
    running = false;
    hideModal();
  }
  // 残りの枚数はヘッダーの「残り N 枚にモザイクをかける」が言うので、ここでは出さない
  renderRun();
  renderStrip();
  // 開いている写真が探し終わったなら描き直す
  if (current && photo(current).detected !== null) {
    renderComposite();
    draw();
    await renderFaces();
  }
}

/** 「あとで」にした・止めたときに、ヘッダーから続きをかけられるようにする */
function renderRun() {
  const b = $<HTMLButtonElement>("run");
  const n = todo().length;
  b.hidden = n === 0 || running;
  b.textContent = `残り ${n} 枚にモザイクをかける`;
}

// ---------- 写真を開く ----------

async function select(name: string) {
  current = name;
  renderStrip();
  busy("読み込んでいます");
  const pv = await invoke<{ w: number; h: number; url: string }>("preview", { folder, name, maxSide: PREVIEW_SIDE });
  if (current !== name) return;
  full = { w: pv.w, h: pv.h };
  img = new Image();
  img.src = pv.url;
  await img.decode();
  composite.width = img.naturalWidth;
  composite.height = img.naturalHeight;
  fit();
  renderComposite();
  draw();
  $<HTMLInputElement>("cells").value = String(maxCells() + minCells() - photo(name).cells);
  await renderFaces();
  if (current === name) busy(null);
}

// 濃さのスライダーは右へ行くほど濃い（マスが少ない）
const minCells = () => Number($<HTMLInputElement>("cells").min);
const maxCells = () => Number($<HTMLInputElement>("cells").max);

// ---------- 描く ----------

const k = () => (img ? img.naturalWidth / full.w : 1);

/** 縮小画像の上に、Rust の書き出しと同じ考え方でモザイクを載せる（枠の幅を cells マスにつぶす） */
function renderComposite() {
  if (!img || !current) return;
  const c = composite.getContext("2d")!;
  c.imageSmoothingEnabled = true;
  c.drawImage(img, 0, 0);
  const p = photo(current);
  const kk = k();
  const tmp = document.createElement("canvas");
  const t = tmp.getContext("2d")!;
  for (const r of regions(p)) {
    const px = r.w * r.pad, py = r.h * r.pad;
    const x0 = Math.max(0, r.x - px) * kk, y0 = Math.max(0, r.y - py) * kk;
    const x1 = Math.min(full.w, r.x + r.w + px) * kk, y1 = Math.min(full.h, r.y + r.h + py) * kk;
    const bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) continue;
    const cols = Math.max(1, p.cells), rows = Math.max(1, Math.round((cols * bh) / bw));
    tmp.width = cols;
    tmp.height = rows;
    t.imageSmoothingEnabled = true;
    t.imageSmoothingQuality = "high";
    t.drawImage(img, x0, y0, bw, bh, 0, 0, cols, rows);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, cols, rows, Math.round(x0), Math.round(y0), Math.round(bw), Math.round(bh));
    c.imageSmoothingEnabled = true;
  }
}

function fit() {
  if (!img) return;
  const r = view.getBoundingClientRect();
  const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) * 0.96;
  zoom = { s, ox: (r.width - img.naturalWidth * s) / 2, oy: (r.height - img.naturalHeight * s) / 2 };
}

// 原寸の座標 <-> 画面の座標
const toScreen = (x: number, y: number) => ({ x: x * k() * zoom.s + zoom.ox, y: y * k() * zoom.s + zoom.oy });
const toFull = (x: number, y: number) => ({ x: (x - zoom.ox) / zoom.s / k(), y: (y - zoom.oy) / zoom.s / k() });

let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
let hover: Item | null = null;

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw() {
  const r = view.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (view.width !== Math.round(r.width * dpr) || view.height !== Math.round(r.height * dpr)) {
    view.width = Math.round(r.width * dpr);
    view.height = Math.round(r.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (!img || !current) return;
  ctx.imageSmoothingEnabled = zoom.s < 1;
  ctx.drawImage(composite, zoom.ox, zoom.oy, composite.width * zoom.s, composite.height * zoom.s);

  const colors = { on: css("--on"), added: css("--added"), off: css("--off") };
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  for (const it of items(photo(current))) {
    const hovered = hover !== null && hover.kind === it.kind && hover.index === it.index;
    if (it.kind === "candidate" && !it.on && !hovered) continue;
    const a = toScreen(it.box.x, it.box.y);
    const b = toScreen(it.box.x + it.box.w, it.box.y + it.box.h);
    const color = !it.on ? colors.off : it.kind === "added" ? colors.added : colors.on;
    ctx.strokeStyle = color;
    ctx.lineWidth = hover === it || (hover && hover.kind === it.kind && hover.index === it.index) ? 3 : 1.5;
    ctx.setLineDash(it.on ? [] : it.kind === "candidate" ? [1.5, 3] : [4, 3]);
    ctx.strokeRect(a.x, a.y, Math.max(2, b.x - a.x), Math.max(2, b.y - a.y));
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(it.label, a.x, a.y - 2);
  }
  if (drag) {
    const removing = (mode === "remove") !== shift;
    ctx.strokeStyle = removing ? colors.off : colors.added;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(removing ? [4, 3] : []);
    ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
    ctx.setLineDash([]);
  }
}

// ---------- 右パネル: 枠の一覧 ----------

async function renderFaces() {
  const box = $("faces");
  if (!current) {
    box.replaceChildren();
    return;
  }
  const name = current;
  const p = photo(name);
  const list = items(p);
  const key = (b: Box) => `${name}|${b.x},${b.y},${b.w},${b.h}`;
  const missing = list.filter((it) => !cropCache.has(key(it.box)));
  if (missing.length) {
    const urls = await invoke<string[]>("crops", { folder, name, regions: missing.map((it) => ({ ...pick(it.box), pad: 0 })), size: 160 });
    missing.forEach((it, i) => cropCache.set(key(it.box), urls[i]!));
    if (current !== name) return;
  }
  // 上は今かかっている顔だけ。外した顔は下の「外した N」に畳む（戻す口は残す）
  const card = (it: Item) => {
      const el = document.createElement("div");
      el.className = `face ${it.kind}${it.on ? "" : " off"}`;
      el.title = it.on ? "クリックで外す" : it.kind === "candidate" ? "顔ならクリックでかける" : "クリックで戻す";
      const im = document.createElement("img");
      im.src = cropCache.get(key(it.box)) ?? "";
      const b = document.createElement("b");
      b.textContent = it.label;
      el.append(im, b);
      el.onclick = () => toggle(it);
      el.onmouseenter = () => {
        hover = it;
        draw();
      };
      el.onmouseleave = () => {
        hover = null;
        draw();
      };
      return el;
  };
  const all = items(p);
  const onGrid = document.createElement("div");
  onGrid.className = "grid";
  onGrid.append(...all.filter((it) => it.on).map(card));
  const nodes: HTMLElement[] = [onGrid];
  // 畳み: 外した顔と、かけていない候補（確度の低い検出。顔は1〜2割なので、かけずに見せるだけ）
  const fold = (list: Item[], label: string, hint: string | null, state: { open: boolean }) => {
    if (list.length === 0) return;
    const d = document.createElement("details");
    d.open = state.open;
    d.ontoggle = () => (state.open = d.open);
    const s = document.createElement("summary");
    s.textContent = `${label} ${list.length}`;
    d.append(s);
    if (hint) {
      const h = document.createElement("p");
      h.className = "hint";
      h.textContent = hint;
      d.append(h);
    }
    const g = document.createElement("div");
    g.className = "grid";
    g.append(...list.map(card));
    d.append(g);
    nodes.push(d);
  };
  fold(all.filter((it) => !it.on && it.kind !== "candidate"), "外した", null, offsOpen);
  fold(all.filter((it) => !it.on && it.kind === "candidate"), "候補", "確度の低い検出です。顔なら、クリックでかけます。", candOpen);
  box.replaceChildren(...nodes);
}
const offsOpen = { open: false };
const candOpen = { open: false };

// ---------- 下パネル: 写真群 ----------

function renderStrip() {
  const groups = { faces: [] as string[], none: [] as string[] };
  const pending: string[] = []; // まだモザイクをかけていない写真は、どちらのタブにも末尾に薄く出す
  for (const n of names) {
    const p = photo(n);
    if (p.detected === null) {
      pending.push(n);
      continue;
    }
    groups[hasFaces(p) ? "faces" : "none"].push(n);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
    const t = b.dataset.tab as "faces" | "none";
    b.setAttribute("aria-selected", String(t === tab));
    b.querySelector("span")!.textContent = String(groups[t].length);
  }
  shown = groups[tab];
  $("thumbs").replaceChildren(
    ...groups[tab].map((n) => {
      const p = photo(n);
      const el = document.createElement("div");
      el.className = `thumb${n === current ? " current" : ""}`;
      el.title = n;
      const url = thumbs.get(n);
      if (url) {
        const im = document.createElement("img");
        im.src = url;
        el.append(im);
      } else {
        const ph = document.createElement("div");
        ph.className = "ph";
        el.append(ph);
      }
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = p.checked;
      cb.title = "書き出す";
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        p.checked = cb.checked;
        renderExport();
        save();
      };
      el.append(cb);
      if (p.exported !== null) {
        const d = document.createElement("span");
        const stale = p.exported !== sig(p);
        d.className = `done${stale ? " stale" : ""}`;
        d.textContent = stale ? "書き出し後に変更" : "書き出し済み";
        el.append(d);
      }
      el.onclick = () => select(n);
      return el;
    }),
    ...pending.map((n) => {
      // まだモザイクをかけていない写真。見るだけはできる
      const el = document.createElement("div");
      el.className = `thumb pending${n === current ? " current" : ""}`;
      el.title = `${n}（まだモザイクをかけていません）`;
      const url = thumbs.get(n);
      if (url) {
        const im = document.createElement("img");
        im.src = url;
        el.append(im);
      } else {
        const ph = document.createElement("div");
        ph.className = "ph";
        el.append(ph);
      }
      const tag = document.createElement("span");
      tag.className = "done";
      tag.textContent = "未";
      el.append(tag);
      el.onclick = () => select(n);
      return el;
    }),
  );
  renderExport();
}

// 全選択・全解除は今の群（顔あり／顔なし）の、探し終えた写真だけに効く
function pickAll(on: boolean) {
  for (const n of shown) photo(n).checked = on;
  renderStrip();
  save();
}

function renderExport() {
  const n = names.filter((x) => photo(x).checked).length;
  $<HTMLButtonElement>("pick-all").disabled = shown.every((x) => photo(x).checked);
  $<HTMLButtonElement>("pick-none").disabled = !shown.some((x) => photo(x).checked);
  const b = $<HTMLButtonElement>("export");
  b.textContent = n > 0 ? `チェックした ${n} 枚を書き出す` : "書き出す";
  b.disabled = n === 0 || exporting;
}

let exporting = false;
async function exportChecked() {
  const targets = names.filter((x) => photo(x).checked);
  exporting = true;
  renderExport();
  let done = 0;
  for (const name of targets) {
    const p = photo(name);
    status(`書き出しています ${done + 1} / ${targets.length}`);
    progress(done, targets.length);
    try {
      await invoke("export", { folder, name, regions: regions(p), cells: p.cells });
      p.exported = sig(p);
      done++;
    } catch (e) {
      status(`${name}: ${e}`);
      progress(0, null);
      exporting = false;
      renderStrip();
      save();
      return;
    }
  }
  exporting = false;
  progress(0, null);
  status(`${done} 枚を書き出しました（<名前>_mosaic.jpg）`);
  renderStrip();
  save();
}

// ---------- 操作 ----------

function itemAt(sx: number, sy: number): Item | null {
  if (!current) return null;
  const f = toFull(sx, sy);
  const hits = items(photo(current)).filter((it) => !(it.kind === "candidate" && !it.on)).filter((it) => f.x >= it.box.x && f.x <= it.box.x + it.box.w && f.y >= it.box.y && f.y <= it.box.y + it.box.h);
  hits.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h); // 重なっていたら小さいほう
  return hits[0] ?? null;
}

let pan: { x: number; y: number } | null = null;

view.addEventListener("contextmenu", (e) => e.preventDefault());
view.addEventListener("pointerdown", (e) => {
  if (!img) return;
  view.setPointerCapture(e.pointerId);
  const r = view.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (e.button === 1 || e.button === 2) {
    pan = { x, y };
    return;
  }
  if (e.button !== 0) return;
  shift = e.shiftKey;
  drag = { x0: x, y0: y, x1: x, y1: y };
});
view.addEventListener("pointermove", (e) => {
  const r = view.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (pan) {
    zoom.ox += x - pan.x;
    zoom.oy += y - pan.y;
    pan = { x, y };
    draw();
    return;
  }
  if (drag) {
    drag.x1 = x;
    drag.y1 = y;
    shift = e.shiftKey;
    draw();
  }
});
view.addEventListener("pointerup", (e) => {
  if (pan) {
    pan = null;
    return;
  }
  if (!drag || !current) return;
  const d = drag;
  drag = null;
  const p = photo(current);
  const moved = Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0);
  if (moved < 5) {
    const it = itemAt(d.x0, d.y0);
    if (it) toggle(it);
    else draw();
    return;
  }
  const a = toFull(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
  const b = toFull(Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
  const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), max));
  const rect = { x: clamp(a.x, full.w), y: clamp(a.y, full.h), w: 0, h: 0 };
  rect.w = clamp(b.x, full.w) - rect.x;
  rect.h = clamp(b.y, full.h) - rect.y;
  const removing = (mode === "remove") !== e.shiftKey;
  if (removing) {
    // 中心が囲みに入った枠を外す
    for (const it of items(p)) {
      const cx = it.box.x + it.box.w / 2, cy = it.box.y + it.box.h / 2;
      if (!it.on || cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) continue;
      if (it.kind === "detected") p.off.push(it.index);
      else if (it.kind === "candidate") p.picked = (p.picked ?? []).filter((i) => i !== it.index);
      else p.added[it.index]!.off = true;
    }
  } else if (rect.w >= 4 && rect.h >= 4) {
    p.added.push(rect);
  }
  changed();
});
view.addEventListener(
  "wheel",
  (e) => {
    if (!img) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    const s = Math.min(Math.max(zoom.s * f, 0.02), 8);
    zoom.ox = x - ((x - zoom.ox) * s) / zoom.s;
    zoom.oy = y - ((y - zoom.oy) * s) / zoom.s;
    zoom.s = s;
    draw();
  },
  { passive: false },
);
view.addEventListener("dblclick", () => {
  fit();
  draw();
});

for (const ev of ["keydown", "keyup"] as const) {
  window.addEventListener(ev, (e) => {
    if (e.key === "Shift" && drag) {
      shift = e.type === "keydown";
      draw();
    }
  });
}
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") return;
  if (!$("modal").hidden || tourOpen()) return; // 幕が出ている間は、後ろの写真を動かさない
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const list = names.filter((n) => photo(n).detected !== null && (tab === "faces") === hasFaces(photo(n)));
    const i = current ? list.indexOf(current) : -1;
    const next = list[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) select(next);
    e.preventDefault();
  }
});

function setMode(m: "add" | "remove") {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) b.setAttribute("aria-checked", String(b.dataset.mode === m));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#mode button")) b.onclick = () => setMode(b.dataset.mode as "add" | "remove");
setMode("add");

for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  b.onclick = () => {
    tab = b.dataset.tab as "faces" | "none";
    renderStrip();
  };
}

$<HTMLInputElement>("cells").addEventListener("input", (e) => {
  if (!current) return;
  photo(current).cells = maxCells() + minCells() - Number((e.target as HTMLInputElement).value);
  renderComposite();
  draw();
  renderStrip();
  save();
});

$("open").onclick = () => openFolder().catch((e) => status(String(e)));
$("help").onclick = () => {
  if (!running) startTour(names.length > 0 ? "all" : "start");
};
$("about").onclick = () => {
  if (!running) startTour("about");
};
tourIfFirst("about", () => tourIfFirst("start"));
$("run").onclick = () => runMosaic().catch((e) => status(String(e)));
$("export").onclick = () => exportChecked();
$("pick-all").onclick = () => pickAll(true);
$("pick-none").onclick = () => pickAll(false);
new ResizeObserver(() => {
  fit();
  draw();
}).observe(view);
