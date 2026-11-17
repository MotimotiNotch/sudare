pub mod detect;
pub mod photo;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

/// サイドカー。中身の形はフロントが決める（Rust は読み書きを通すだけ）
const SIDECAR: &str = "mosaic.json";

#[derive(Serialize)]
struct Scan {
    names: Vec<String>,
    sidecar: Option<String>,
}

#[tauri::command]
fn scan(folder: String) -> Result<Scan, String> {
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| photo::is_target(n))
        .collect();
    names.sort();
    let sidecar = std::fs::read_to_string(std::path::Path::new(&folder).join(SIDECAR)).ok();
    Ok(Scan { names, sidecar })
}

#[tauri::command]
fn save_sidecar(folder: String, text: String) -> Result<(), String> {
    let p = std::path::Path::new(&folder).join(SIDECAR);
    let tmp = p.with_extension("json.part");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Detected {
    w: u32,
    h: u32,
    faces: Vec<detect::Face>,
}

#[tauri::command]
async fn detect_faces(folder: String, name: String) -> Result<Detected, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = photo::load(&photo::resolve(&folder, &name)?)?;
        let faces = detect::detect(&img).map_err(|e| e.to_string())?;
        Ok(Detected { w: img.width(), h: img.height(), faces })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Preview {
    w: u32,
    h: u32,
    /// data URL（image/jpeg）
    url: String,
}

/// 表示用に縮めた画像。`w`・`h` は原寸（枠の座標は原寸で持つ）
#[tauri::command]
async fn preview(folder: String, name: String, max_side: u32) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = photo::load(&photo::resolve(&folder, &name)?)?;
        let small = photo::shrink(&img, max_side);
        let jpg = photo::encode_jpeg(&small, 85)?;
        Ok(Preview { w: img.width(), h: img.height(), url: format!("data:image/jpeg;base64,{}", B64.encode(jpg)) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 枠の切り抜き（右パネル用）。原寸から切るので、小さい顔も潰れない
#[tauri::command]
async fn crops(folder: String, name: String, regions: Vec<photo::Region>, size: u32) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = photo::load(&photo::resolve(&folder, &name)?)?;
        let (iw, ih) = img.dimensions();
        regions
            .iter()
            .map(|r| {
                // 枠の周りも少し見せる（何の顔か分かるように）
                let m = r.w.max(r.h) * 0.6;
                let x0 = (r.x - m).max(0.0) as u32;
                let y0 = (r.y - m).max(0.0) as u32;
                let x1 = ((r.x + r.w + m).min(iw as f32)) as u32;
                let y1 = ((r.y + r.h + m).min(ih as f32)) as u32;
                let sub = image::imageops::crop_imm(&*img, x0, y0, (x1 - x0).max(1), (y1 - y0).max(1)).to_image();
                let fit = image::imageops::resize(&sub, size, size, image::imageops::FilterType::Triangle);
                let jpg = photo::encode_jpeg(&fit, 85)?;
                Ok(format!("data:image/jpeg;base64,{}", B64.encode(jpg)))
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export(folder: String, name: String, regions: Vec<photo::Region>, cells: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || photo::export(&folder, &name, &regions, cells))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan, save_sidecar, detect_faces, preview, crops, export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
