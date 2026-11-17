// アプリアイコン（`assets/app-icon*.svg`）を生成する。Sirube の `scripts/gen-app-icon.ts` に倣った作り。
//
// 図: 円の左半分はそのまま（淡い塗り）、右半分はモザイクのマス。Sudare の主張——
// 向こうの気配は通しつつ、顔だけを隠す——を「同じ円の半分だけが粗くなる」で言う。
//
// Sirube と揃えたもの: viewBox 64、Sirube の青を少し濃くした塗りの半透明＋同色の縁、
// OS 用は角丸の下地（#f5f3ef, rx 13.5）、16〜24px 用は要素を減らした別版。
//
// 使い方: bun run scripts/gen-app-icon.ts [--variant=a|b] [--plate] [--small] [--out=path]

const VB = 64;
const C = { x: 32, y: 32, r: 22 };
// Sirube の青（HSL 210/50/70）から明度だけ下げた HSL 210/50/62
const BLUE = "#6e9ecf";
const FILL_OPACITY = 0.55;
const PLATE_BG = "#f5f3ef";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VARIANT = arg("variant") ?? "b"; // b を採用
const PLATE = process.argv.includes("--plate");
const SMALL = process.argv.includes("--small");

const r2 = (n: number) => Math.round(n * 100) / 100;

// マスの濃さ。乱数ではなく座標の混ぜ合わせで決める（作り直しても同じ絵になる、列や行に縞が出ない）
const tone = (i: number, j: number) => {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return r2(0.32 + ((h >>> 0) % 1000) / 1000 * 0.63);
};

/** 右半分のマス。中心が円に入るマスだけ並べる（縁が階段になる＝モザイクらしさ） */
function tiles(cell: number, gap: number): string {
  const out: string[] = [];
  const n = Math.ceil(C.r / cell) + 1;
  for (let i = 0; i < n; i++) {
    for (let j = -n; j < n; j++) {
      const x = C.x + i * cell;
      const y = C.y + j * cell;
      const cx = x + cell / 2, cy = y + cell / 2;
      if (Math.hypot(cx - C.x, cy - C.y) > C.r) continue;
      out.push(`<rect x="${r2(x + gap / 2)}" y="${r2(y + gap / 2)}" width="${r2(cell - gap)}" height="${r2(cell - gap)}" fill="${BLUE}" fill-opacity="${tone(i, j)}"/>`);
    }
  }
  return out.map((s) => `    ${s}`).join("\n");
}

// 左の半円。塗りは半円、縁は円弧だけ（中央の直線に縁を付けると、マスとの境目が壁に見える）
const leftHalf = (stroke: number) =>
  `<path d="M ${C.x} ${C.y - C.r} A ${C.r} ${C.r} 0 0 0 ${C.x} ${C.y + C.r} Z" fill="${BLUE}" fill-opacity="${FILL_OPACITY}"/>
  <path d="M ${C.x} ${C.y - C.r} A ${C.r} ${C.r} 0 0 0 ${C.x} ${C.y + C.r}" stroke="${BLUE}" stroke-width="${stroke}" stroke-linecap="round"/>`;

let body: string;
if (SMALL) {
  // 16px では細かいマスは潰れる。マスを大きく、数を減らし、隙間なしで
  body = `  ${leftHalf(3.2)}\n  <g>\n${tiles(7.4, 0)}\n  </g>`;
} else if (VARIANT === "a") {
  // a: 右半分も円で切り抜く（輪郭が丸のまま、中だけマス）
  body = `  <defs><clipPath id="r"><path d="M ${C.x} ${C.y - C.r} A ${C.r} ${C.r} 0 0 1 ${C.x} ${C.y + C.r} Z"/></clipPath></defs>
  ${leftHalf(2.8)}
  <g clip-path="url(#r)">
${tiles(5.5, 0)}
  </g>
  <path d="M ${C.x} ${C.y - C.r} A ${C.r} ${C.r} 0 0 1 ${C.x} ${C.y + C.r}" fill="none" stroke="${BLUE}" stroke-width="2.8"/>`;
} else {
  // b: 右半分は切り抜かず、中心が円に入るマスだけ（縁が階段）
  body = `  ${leftHalf(2.8)}\n  <g>\n${tiles(5.5, 0.9)}\n  </g>`;
}

const plateRect = PLATE ? `  <rect x="0" y="0" width="${VB}" height="${VB}" rx="13.5" fill="${PLATE_BG}"/>\n` : "";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${VB}" height="${VB}" fill="none" role="img" aria-label="Sudare">
${plateRect}${body}
</svg>
`;

const out = arg("out") ?? `assets/app-icon${SMALL ? "-small" : ""}${PLATE ? "-plate" : ""}.svg`;
await Bun.write(out, svg);
console.log(`${out} を書き出しました`);
