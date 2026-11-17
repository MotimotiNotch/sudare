//! 顔の検出。YuNet（opencv_zoo の face_detection_yunet_2023mar）を tract で動かす。
//!
//! 手順は OpenCV の `FaceDetectorYN` と同じ（2026-11-17、実写真 1 枚で 24 個の枠が
//! cv2 と一致することを Python で確かめてから移した）:
//! - 長辺 4000px まで縮めて、32 の倍数まで右下を 0 で埋める（BGR・0〜255 のまま、正規化しない）
//! - stride 8/16/32 の格子ごとに score = sqrt(cls × obj)、枠は (列 + dx, 行 + dy) × stride を中心に exp(dw/dh) × stride
//! - score 0.3 以上を、IoU 0.3 の NMS でまとめる。0.6 以上を「見つけた顔」、0.3〜0.6 を「候補」として
//!   画面側で分ける（2026-11-17。0.3〜0.6 の新しい枠は 181 枚で 1143 個、顔は 1〜2 割だったので、かけずに見せる）。
//!   スコアの高い順に NMS をかけるので、低い枠を足しても 0.6 以上の集まりと並びは変わらない（外した番号がずれない）
//!
//! モデルは入力の高さ・幅を可変にした写し（`models/yunet_2023mar_dyn.onnx`。元の 640×640 固定の
//! 宣言を書き換えただけで、重みは同じ）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use image::{imageops::FilterType, RgbImage};
use serde::Serialize;
use tract_onnx::prelude::*;

const MODEL: &[u8] = include_bytes!("../models/yunet_2023mar_dyn.onnx");
pub const MAX_DETECT_SIDE: u32 = 4000;
pub const SCORE: f32 = 0.3;
const NMS_IOU: f32 = 0.3;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
}

type Plan = Arc<TypedRunnableModel<TypedModel>>;

/// 入力の大きさごとに最適化済みの計画を持つ（同じカメラの写真は大きさがそろうので、ほぼ 1〜2 個で済む）
fn plan_for(w: usize, h: usize) -> TractResult<Plan> {
    static PLANS: OnceLock<Mutex<HashMap<(usize, usize), Plan>>> = OnceLock::new();
    let plans = PLANS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(p) = plans.lock().unwrap().get(&(w, h)) {
        return Ok(p.clone());
    }
    let plan: Plan = tract_onnx::onnx()
        .model_for_read(&mut std::io::Cursor::new(MODEL))?
        .with_input_fact(0, f32::fact([1, 3, h, w]).into())?
        .into_optimized()?
        .into_runnable()?
        .into();
    plans.lock().unwrap().insert((w, h), plan.clone());
    Ok(plan)
}

pub fn detect(img: &RgbImage) -> TractResult<Vec<Face>> {
    let (w, h) = img.dimensions();
    let scale = (MAX_DETECT_SIDE as f32 / w.max(h) as f32).min(1.0);
    let small;
    let src = if scale < 1.0 {
        small = image::imageops::resize(
            img,
            (w as f32 * scale).round() as u32,
            (h as f32 * scale).round() as u32,
            FilterType::Lanczos3,
        );
        &small
    } else {
        img
    };
    let (sw, sh) = (src.width() as usize, src.height() as usize);
    let pw = sw.div_ceil(32) * 32;
    let ph = sh.div_ceil(32) * 32;

    let mut data = vec![0f32; 3 * pw * ph];
    for (x, y, p) in src.enumerate_pixels() {
        let i = y as usize * pw + x as usize;
        data[i] = p[2] as f32; // B
        data[pw * ph + i] = p[1] as f32; // G
        data[2 * pw * ph + i] = p[0] as f32; // R
    }
    let input: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, ph, pw), data)?.into();
    let out = plan_for(pw, ph)?.run(tvec!(input.into()))?;

    // 出力の並び: cls_8, cls_16, cls_32, obj_8, obj_16, obj_32, bbox_8, bbox_16, bbox_32, kps_*
    let mut cands: Vec<Face> = Vec::new();
    for (k, stride) in [8usize, 16, 32].into_iter().enumerate() {
        let cls = out[k].to_array_view::<f32>()?;
        let obj = out[3 + k].to_array_view::<f32>()?;
        let bb = out[6 + k].to_array_view::<f32>()?;
        let cols = pw / stride;
        let n = cls.shape()[1];
        for i in 0..n {
            let c = cls[[0, i, 0]].clamp(0.0, 1.0);
            let o = obj[[0, i, 0]].clamp(0.0, 1.0);
            let score = (c * o).sqrt();
            if score < SCORE {
                continue;
            }
            let (r, col) = (i / cols, i % cols);
            let s = stride as f32;
            let cx = (col as f32 + bb[[0, i, 0]]) * s;
            let cy = (r as f32 + bb[[0, i, 1]]) * s;
            let bw = bb[[0, i, 2]].exp() * s;
            let bh = bb[[0, i, 3]].exp() * s;
            cands.push(Face { x: cx - bw / 2.0, y: cy - bh / 2.0, w: bw, h: bh, score });
        }
    }

    cands.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Face> = Vec::new();
    for f in cands {
        if keep.iter().all(|k| iou(&f, k) <= NMS_IOU) {
            keep.push(f);
        }
    }
    Ok(keep
        .into_iter()
        .map(|f| Face { x: f.x / scale, y: f.y / scale, w: f.w / scale, h: f.h / scale, score: f.score })
        .collect())
}

fn iou(a: &Face, b: &Face) -> f32 {
    let iw = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0);
    let ih = ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
    let inter = iw * ih;
    inter / (a.w * a.h + b.w * b.h - inter)
}
