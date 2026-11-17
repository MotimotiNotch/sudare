// チュートリアル（画面の場所を1つずつ照らして、そこでできることを言う）。
//
// 起動直後に「このツールについて」→「フォルダを開く」、初めて写真が並んだときに残りの段を、それぞれ1回だけ自動で出す。
// あとはヘッダーの「使い方」「このツールについて」からいつでも開ける（2つは別の窓）。
// 見たかどうかは localStorage に持つ（フォルダごとのサイドカーではなく、この PC の Sudare に1つ）。
// 動きは付けない（使う道具の声）。照らす穴の外だけを暗くし、説明の札は不透明。

import { openUrl } from "@tauri-apps/plugin-opener";

/** target が null の段は何も照らさず、札を窓の真ん中に出す */
type Step = { target: string | null; title: string; body: string[]; link?: { label: string; url: string } };

const KOFI = "https://ko-fi.com/motimotinotch";

/** 「このツールについて」。使い方とは別の窓で、1枚だけ */
const ABOUT: Step[] = [
  {
    target: null,
    title: "Sudare について",
    body: [
      "写真に写った人の顔を見つけてモザイクをかけ、外す・足すを確かめて直してから書き出すツールです。名前は簾（すだれ）から。向こうの気配は通しつつ、顔だけを隠します。",
      "仕組み: 顔を見つける学習済みのモデル（OpenCV の YuNet）をこの PC の中で動かし、顔らしい場所を枠で推定します。枠を頬や髪まで少し広げ、その範囲を粗いマスに置き換えます。書き出すときは原本から作り直すので、原本は書き換えません。",
      "モデルの推定は完全ではありません。顔でないもの（動物・ポスター・模様など）にモザイクをかけたり、横顔・小さい顔・暗い顔・一部が隠れた顔にかけなかったりすることがあります。書き出す前に、必ず目で確かめてください。",
      "写真はこの PC の中だけで扱います。どこにも送りません。",
      "個人で作っています。役に立ったら、Ko-fi で応援してもらえると続ける力になります。",
    ],
    link: { label: "Ko-fi で応援する", url: KOFI },
  },
];

/** 起動してすぐ（まだフォルダを開いていない）に見せる段 */
const START: Step[] = [
  {
    target: "#open",
    title: "まず、フォルダを開く",
    body: [
      "モザイクをかけたい写真のフォルダを選びます。対象はそのフォルダの直下の JPG だけで、下の階層のフォルダは見ません。",
      "開くと写真を読み込み、「一括でかけますか」と聞いてから顔を探します。枚数が多いと時間が掛かりますが、途中で止めても済んだ分は残ります。",
      "原本は書き換えません。続きの使い方は、写真が並んだところで案内します。",
    ],
  },
];

/** 写真が並んでから見せる段 */
const PHOTOS: Step[] = [
  {
    target: "#stage",
    title: "見つけた顔には、もうモザイクがかかっています",
    body: [
      "赤い枠が見つけた顔です。最初は全部にかかった状態で始まります。",
      "顔でないもの（犬・ポスター等）は、枠をクリックすると外れて灰色の破線になります。もう一度クリックで戻ります。",
    ],
  },
  {
    target: "#stage",
    title: "取りこぼしは、囲んで足す",
    body: [
      "写真の上をドラッグして囲むと、そこに枠を足します（琥珀色）。",
      "「外す」モードで囲むと、中心が入った枠をまとめて外します。Shift を押している間だけ逆のモードになります。",
      "ホイールで拡大、右ドラッグで移動、ダブルクリックで全体に戻ります。小さい顔は拡大してから囲んでください。",
    ],
  },
  {
    target: "#mode",
    title: "足す／外すの切り替え",
    body: ["囲んだときの動きをここで切り替えます。枠のクリックは、どちらのモードでも外す／戻すです。"],
  },
  {
    target: "#faces",
    title: "顔の切り抜き",
    body: [
      "枠の中を切り抜いて並べています。全体表示で点になる小さい顔も、ここならクリックで外せます。",
      "ここにカーソルを載せると、写真の上の枠が太くなります。外した顔は下の「外した N」に畳まれ、そこから戻せます。その下の「候補 N」は、顔かどうか自信の低い検出です。最初はかけていないので、奥の小さい顔などが混じっていたら、クリックでかけてください。",
    ],
  },
  {
    target: "#cells-row",
    title: "濃さ",
    body: ["右ほど粗い（顔が分からない）モザイクです。写真ごとに1つの値で、その写真の全部の枠に効きます。"],
  },
  {
    target: "#groups",
    title: "顔あり／顔なし",
    body: [
      "顔が見つかった写真と、1つも見つからなかった写真を分けて並べます。",
      "顔なしの群も一度は眺めてください。横顔や小さい顔は見落とされることがあり、ここに紛れます。",
    ],
  },
  {
    target: "#thumbs",
    title: "書き出す写真を選ぶ",
    body: [
      "左上のチェックが入った写真を書き出します。顔ありは最初から入、顔なしは切です。",
    ],
  },
  {
    target: "#export",
    title: "書き出す",
    body: [
      "原本はそのままで、同じフォルダに「<名前>_mosaic.jpg」を作ります。位置情報（GPS）は落とします。",
      "外した・足した指定はフォルダの mosaic.json に残るので、あとで開き直して直せます。直したあとは「書き出し後に変更」と出ます。",
    ],
  },
];

const SEEN = { about: "sudare.about.seen", start: "sudare.tour.intro.seen", photos: "sudare.tour.seen" } as const;
type Phase = keyof typeof SEEN;

let root: HTMLElement | null = null;
let at = 0;
let STEPS: Step[] = PHOTOS;
let phase: Phase = "photos";
let onClose: (() => void) | null = null;

export const tourOpen = () => root !== null;

/** 初めてなら出す（about → start は起動時、photos は写真が並んだあと）。見たことがあれば close をすぐ呼ぶ */
export function tourIfFirst(p: Phase, close?: () => void) {
  if (localStorage.getItem(SEEN[p]) !== "1") startTour(p, close);
  else close?.();
}

/** 「使い方」から。フォルダを開く前なら開き方だけ、開いたあとなら全部 */
export function startTour(p: Phase | "all", close?: () => void) {
  if (root) return;
  onClose = close ?? null;
  at = 0;
  STEPS = p === "about" ? ABOUT : p === "start" ? START : p === "photos" ? PHOTOS : [...START.map(withoutLast), ...PHOTOS];
  phase = p === "all" ? "photos" : p;
  root = document.createElement("div");
  root.id = "tour";
  root.innerHTML = `
    <div class="hole"></div>
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div class="count"></div>
      <h2 id="tour-title"></h2>
      <div class="body"></div>
      <div class="actions">
        <button class="skip">閉じる</button>
        <span></span>
        <button class="back">戻る</button>
        <button class="next primary"></button>
      </div>
    </div>`;
  root.querySelector<HTMLButtonElement>(".skip")!.onclick = endTour;
  root.querySelector<HTMLButtonElement>(".back")!.onclick = () => go(at - 1);
  root.querySelector<HTMLButtonElement>(".next")!.onclick = () => (at === STEPS.length - 1 ? endTour() : go(at + 1));
  document.body.append(root);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  go(0);
}

function endTour() {
  if (!root) return;
  localStorage.setItem(SEEN[phase], "1");
  if (phase === "photos") localStorage.setItem(SEEN.start, "1"); // 全部を見たなら開き方も見ている
  root.remove();
  root = null;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", place);
  onClose?.();
  onClose = null;
}

/** 照らしている間は、後ろの画面にキーを渡さない */
function onKey(e: KeyboardEvent) {
  if (!root) return;
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight" || e.key === "Enter") at === STEPS.length - 1 ? endTour() : go(at + 1);
  else if (e.key === "ArrowLeft") go(at - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function go(i: number) {
  if (!root || i < 0 || i >= STEPS.length) return;
  at = i;
  const s = STEPS[i]!;
  // 1枚だけのとき（このツールについて・開き方）は、数・戻る・閉じる（左）を出さない
  const single = STEPS.length === 1;
  root.querySelector<HTMLElement>(".count")!.hidden = single;
  root.querySelector<HTMLElement>(".skip")!.hidden = single;
  root.querySelector<HTMLElement>(".back")!.hidden = single;
  root.querySelector(".count")!.textContent = `${i + 1} / ${STEPS.length}`;
  root.querySelector("h2")!.textContent = s.title;
  root.querySelector(".body")!.replaceChildren(
    ...s.body.map((t) => {
      const p = document.createElement("p");
      p.textContent = t;
      return p;
    }),
  );
  if (s.link) {
    const { url, label } = s.link;
    const a = document.createElement("a");
    a.href = url;
    a.textContent = label;
    a.className = "link";
    a.onclick = (e) => {
      e.preventDefault();
      openUrl(url).catch(() => {});
    };
    root.querySelector(".body")!.append(a);
  }
  root.querySelector<HTMLButtonElement>(".back")!.disabled = i === 0;
  const next = root.querySelector<HTMLButtonElement>(".next")!;
  next.textContent = i < STEPS.length - 1 ? "次へ" : phase === "photos" ? "始める" : "閉じる";
  place();
  next.focus();
}

const GAP = 12;

/** 照らす穴を対象に重ね、札を対象の外の空いている側に置く */
function place() {
  if (!root) return;
  const sel = STEPS[at]!.target;
  const target = sel ? document.querySelector<HTMLElement>(sel) : null;
  const hole = root.querySelector<HTMLElement>(".hole")!;
  const card = root.querySelector<HTMLElement>(".card")!;
  const vw = window.innerWidth, vh = window.innerHeight;
  const t = target?.getBoundingClientRect() ?? new DOMRect(vw / 2, vh / 2, 0, 0);
  const pad = 4;
  // 照らすものが無い段は、窓全体を暗くして札を真ん中に
  hole.classList.toggle("none", !target);
  if (!target) {
    card.style.left = `${(vw - card.offsetWidth) / 2}px`;
    card.style.top = `${(vh - card.offsetHeight) / 2}px`;
    return;
  }
  Object.assign(hole.style, {
    left: `${t.left - pad}px`,
    top: `${t.top - pad}px`,
    width: `${t.width + pad * 2}px`,
    height: `${t.height + pad * 2}px`,
  });

  const cw = card.offsetWidth, ch = card.offsetHeight;
  const clampX = (x: number) => Math.min(Math.max(x, GAP), vw - cw - GAP);
  const clampY = (y: number) => Math.min(Math.max(y, GAP), vh - ch - GAP);
  // 下・上・左・右の順に、対象に重ならずに収まる側を探す
  const tries: [boolean, number, number][] = [
    [vh - t.bottom >= ch + GAP * 2, clampX(t.left + t.width / 2 - cw / 2), t.bottom + GAP],
    [t.top >= ch + GAP * 2, clampX(t.left + t.width / 2 - cw / 2), t.top - ch - GAP],
    [t.left >= cw + GAP * 2, t.left - cw - GAP, clampY(t.top + t.height / 2 - ch / 2)],
    [vw - t.right >= cw + GAP * 2, t.right + GAP, clampY(t.top + t.height / 2 - ch / 2)],
  ];
  const hit = tries.find(([fits]) => fits);
  // どこにも収まらない（写真の領域のように大きい）ときは、対象の内側の左下に置く
  const [x, y] = hit ? [hit[1], hit[2]] : [clampX(t.left + GAP * 2), clampY(t.bottom - ch - GAP * 2)];
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
}

/** 全部を続けて見せるときは、開き方の段から「続きは写真が並んだところで」を落とす */
function withoutLast(s: Step): Step {
  return { ...s, body: s.body.slice(0, -1) };
}
