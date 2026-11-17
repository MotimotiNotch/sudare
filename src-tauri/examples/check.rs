//! 検出と書き出しを画面なしで確かめるための確認用。
//! cargo run --release --example check -- <フォルダ> <名前> [外す番号,...]
//! 検出した枠を JSON で出し、外す番号を除いてフォルダに <名前>_mosaic.jpg を書く。

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (folder, name) = (&args[1], &args[2]);
    let drop: Vec<usize> = args.get(3).map(|s| s.split(',').filter_map(|x| x.parse().ok()).collect()).unwrap_or_default();
    let t = Instant::now();
    let img = sudare_lib::photo::load(&sudare_lib::photo::resolve(folder, name).unwrap()).unwrap();
    eprintln!("load {:?}", t.elapsed());
    let t = Instant::now();
    let faces = sudare_lib::detect::detect(&img).unwrap();
    eprintln!("detect {:?} faces={}", t.elapsed(), faces.len());
    for (i, f) in faces.iter().enumerate() {
        println!("{} {} {} {} {} {:.3}", i + 1, f.x as i32, f.y as i32, f.w as i32, f.h as i32, f.score);
    }
    let regions: Vec<sudare_lib::photo::Region> = faces
        .iter()
        .enumerate()
        .filter(|(i, _)| !drop.contains(&(i + 1)))
        .map(|(_, f)| sudare_lib::photo::Region { x: f.x, y: f.y, w: f.w, h: f.h, pad: 0.35 })
        .collect();
    let t = Instant::now();
    let out = sudare_lib::photo::export(folder, name, &regions, 8).unwrap();
    eprintln!("export {:?} -> {out}", t.elapsed());
}
