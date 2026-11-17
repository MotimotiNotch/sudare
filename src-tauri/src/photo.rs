//! 写真の読み込み・縮小・モザイク・書き出し。
//!
//! 書き出しの EXIF は、原本の EXIF を**許可リストの項目だけ**で組み直す。消したいもの（GPS・
//! 埋め込みの縮小画像＝モザイク前の顔が写っている・メーカーノート）を数え上げて消すのではなく、
//! 残すものだけを数え上げる。新しい種類の情報が増えても、黙って持ち込まれない。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use exif::{experimental::Writer, Field, In, Tag, Value};
use image::{imageops::FilterType, DynamicImage, ImageDecoder, ImageReader, RgbImage};
use img_parts::{jpeg::Jpeg, ImageEXIF};
use serde::Deserialize;

pub const MOSAIC_SUFFIX: &str = "_mosaic";

pub fn is_target(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let is_jpg = lower.ends_with(".jpg") || lower.ends_with(".jpeg");
    let stem = lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&lower);
    is_jpg && !stem.ends_with(MOSAIC_SUFFIX)
}

/// フォルダの外を指す名前（`..`・区切り文字）を通さない
pub fn resolve(folder: &str, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(format!("名前が不正: {name}"));
    }
    Ok(Path::new(folder).join(name))
}

/// 向きを画素に焼き込んだ RGB。直前に読んだ1枚は持っておく（切り抜きを続けて頼まれるため）
pub fn load(path: &Path) -> Result<Arc<RgbImage>, String> {
    static LAST: OnceLock<Mutex<Option<(PathBuf, Arc<RgbImage>)>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(None));
    if let Some((p, img)) = last.lock().unwrap().as_ref() {
        if p == path {
            return Ok(img.clone());
        }
    }
    let mut dec = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    let orientation = dec.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    let rgb = Arc::new(img.into_rgb8());
    *last.lock().unwrap() = Some((path.to_path_buf(), rgb.clone()));
    Ok(rgb)
}

pub fn encode_jpeg(img: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(img)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn shrink(img: &RgbImage, max_side: u32) -> RgbImage {
    let (w, h) = img.dimensions();
    let s = (max_side as f32 / w.max(h) as f32).min(1.0);
    if s >= 1.0 {
        return img.clone();
    }
    image::imageops::resize(img, ((w as f32 * s).round() as u32).max(1), ((h as f32 * s).round() as u32).max(1), FilterType::Triangle)
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// 検出した枠は顔の周り（頬・髪）まで広げる。手で描いた枠は描いたとおり（0）
    pub pad: f32,
}

/// 枠ごとに、枠の幅を `cells` マスにつぶす
pub fn pixelate(img: &mut RgbImage, regions: &[Region], cells: u32) {
    let (iw, ih) = img.dimensions();
    for r in regions {
        let (px, py) = (r.w * r.pad, r.h * r.pad);
        let x0 = (r.x - px).max(0.0) as u32;
        let y0 = (r.y - py).max(0.0) as u32;
        let x1 = ((r.x + r.w + px).min(iw as f32)) as u32;
        let y1 = ((r.y + r.h + py).min(ih as f32)) as u32;
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (bw, bh) = (x1 - x0, y1 - y0);
        let cols = cells.max(1);
        let rows = ((cols as f32 * bh as f32 / bw as f32).round() as u32).max(1);
        let sub = image::imageops::crop_imm(img, x0, y0, bw, bh).to_image();
        let tiny = image::imageops::resize(&sub, cols, rows, FilterType::Triangle);
        let big = image::imageops::resize(&tiny, bw, bh, FilterType::Nearest);
        image::imageops::replace(img, &big, x0 as i64, y0 as i64);
    }
}

/// 原本の EXIF から残す項目。撮影の記録（いつ・何で・どう撮ったか）だけ
const KEEP: &[Tag] = &[
    Tag::Make,
    Tag::Model,
    Tag::Artist,
    Tag::Copyright,
    Tag::DateTimeOriginal,
    Tag::DateTimeDigitized,
    Tag::OffsetTime,
    Tag::OffsetTimeOriginal,
    Tag::ExposureTime,
    Tag::FNumber,
    Tag::ExposureProgram,
    Tag::PhotographicSensitivity,
    Tag::ExposureBiasValue,
    Tag::MeteringMode,
    Tag::Flash,
    Tag::FocalLength,
    Tag::FocalLengthIn35mmFilm,
    Tag::WhiteBalance,
    Tag::LensMake,
    Tag::LensModel,
    Tag::ColorSpace,
];

fn rebuilt_exif(src: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else {
        return Ok(None);
    };
    let mut fields: Vec<Field> = exif
        .fields()
        .filter(|f| f.ifd_num == In::PRIMARY && KEEP.contains(&f.tag))
        .cloned()
        .collect();
    // 向きは画素に焼き込んだので 1。DateTime は書き出した時刻にして、DateTimeOriginal（撮影日時）と分ける
    fields.push(Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![1]) });
    let now = chrono::Local::now().format("%Y:%m:%d %H:%M:%S").to_string();
    fields.push(Field { tag: Tag::DateTime, ifd_num: In::PRIMARY, value: Value::Ascii(vec![now.into_bytes()]) });
    fields.push(Field {
        tag: Tag::Software,
        ifd_num: In::PRIMARY,
        value: Value::Ascii(vec![b"Sudare".to_vec()]),
    });

    let mut w = Writer::new();
    for f in &fields {
        w.push_field(f);
    }
    let mut buf = Cursor::new(Vec::new());
    w.write(&mut buf, exif.little_endian()).map_err(|e| e.to_string())?;
    Ok(Some(buf.into_inner()))
}

pub fn mosaic_name(name: &str) -> String {
    let (stem, _) = name.rsplit_once('.').unwrap_or((name, "jpg"));
    format!("{stem}{MOSAIC_SUFFIX}.jpg")
}

/// 原本から作り直して `<名前>_mosaic.jpg` に書く。原本には触れない
pub fn export(folder: &str, name: &str, regions: &[Region], cells: u32) -> Result<String, String> {
    let src = resolve(folder, name)?;
    let mut img = (*load(&src)?).clone();
    pixelate(&mut img, regions, cells);
    let encoded = encode_jpeg(&img, 92)?;
    let mut jpeg = Jpeg::from_bytes(encoded.into()).map_err(|e| e.to_string())?;
    jpeg.set_exif(rebuilt_exif(&src)?.map(Into::into));
    let out_name = mosaic_name(name);
    let out = resolve(folder, &out_name)?;
    let tmp = out.with_extension("jpg.part");
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    jpeg.encoder().write_to(file).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out_name)
}
