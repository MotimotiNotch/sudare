// 配る exe を作る: ライセンス表記を焼き直してから、手元のパスを消して Tauri でビルドする。
//
//   bun run release            → exe とインストーラ（NSIS）
//   bun run release --no-bundle → exe だけ（src-tauri/target/release/sudare.exe）
//
// パスを消す理由: 依存の panic 位置として `C:/Users/<名前>/.cargo/registry/...` が exe に
// 約1000か所入り、ユーザー名が読める（2026-11-17 release-checker）。Cargo の `trim-paths` は
// 1.98 ではまだ unstable なので、rustc の `--remap-path-prefix` を RUSTFLAGS で渡す。
// 値が手元のパスになるので、Cargo.toml や .cargo/config.toml には書かずにここで組み立てる。
// RUSTFLAGS が変わると依存も全部作り直しになる（初回だけ数分かかる）。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("bun", ["run", "scripts/gen-licenses.ts"]);

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const rustupHome = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
const remaps = [
  [cargoHome, "/cargo"],
  [rustupHome, "/rustup"],
  [resolve("."), "/sudare"],
  [homedir(), "/home"], // 上のどれにも当たらない手元のパスの受け皿
].flatMap(([from, to]) => [`--remap-path-prefix=${from}=${to}`]);

const rustflags = [process.env.RUSTFLAGS ?? "", ...remaps].filter(Boolean).join(" ");
run("bun", ["run", "tauri", "build", ...process.argv.slice(2)], { ...process.env, RUSTFLAGS: rustflags });
