//! スモークテスト。CI（`.github/workflows/ci.yml`）とリリースの前に回す。
//!
//! 見ているのは「壊れたら黙って困るもの」だけ:
//! - 同梱のモデルが読めて、推論が最後まで走る（顔の無い画像で 0 個）
//! - 書き出しが、GPS・埋め込みの縮小画像を持ち込まず、向きを画素に焼き込み、撮影の記録は残す
//! - モザイクは枠の中だけにかかる
//! - フォルダの外を指す名前を通さない、`*_mosaic.jpg` を対象から外す
//!
//! 本物の顔を見つけられるかは見ていない（リポジトリに人の顔の写真を置かないため）。

use std::io::Cursor;
use std::path::PathBuf;

use exif::{experimental::Writer, Field, In, Tag, Value};
use image::{Rgb, RgbImage};
use img_parts::{jpeg::Jpeg, ImageEXIF};
use sudare_lib::{detect, photo};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sudare-smoke-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 左半分が赤・右半分が青の横長の写真に、GPS・向き（右に 90°）・縮小画像・機材の EXIF を付けて書く
fn write_source(path: &PathBuf) {
    let img = RgbImage::from_fn(64, 32, |x, _| if x < 32 { Rgb([220, 30, 30]) } else { Rgb([30, 30, 220]) });
    let encoded = photo::encode_jpeg(&img, 95).unwrap();

    let thumb = photo::encode_jpeg(&RgbImage::from_pixel(8, 4, Rgb([0, 255, 0])), 80).unwrap();
    let make = Field { tag: Tag::Make, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"TestCam".to_vec()]) };
    let orientation = Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![6]) };
    let gps_ref = Field { tag: Tag::GPSLatitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"N".to_vec()]) };
    let mut w = Writer::new();
    w.push_field(&make);
    w.push_field(&orientation);
    w.push_field(&gps_ref);
    w.set_jpeg(&thumb, In::THUMBNAIL);
    let mut exif_buf = Cursor::new(Vec::new());
    w.write(&mut exif_buf, false).unwrap();

    let mut jpeg = Jpeg::from_bytes(encoded.into()).unwrap();
    jpeg.set_exif(Some(exif_buf.into_inner().into()));
    jpeg.encoder().write_to(std::fs::File::create(path).unwrap()).unwrap();
}

#[test]
fn model_loads_and_finds_no_face_in_blank_image() {
    let img = RgbImage::from_pixel(640, 480, Rgb([128, 128, 128]));
    let faces = detect::detect(&img).expect("モデルの読み込みか推論が失敗した");
    assert!(faces.is_empty(), "無地の画像で顔が {} 個見つかった", faces.len());
}

#[test]
fn export_drops_gps_and_thumbnail_and_bakes_orientation() {
    let dir = workdir("export");
    let folder = dir.to_str().unwrap();
    write_source(&dir.join("a.jpg"));

    // 原本の EXIF に、落とすべきものが本当に入っていることを先に確かめる（陽性対照）
    let src = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(std::fs::File::open(dir.join("a.jpg")).unwrap())).unwrap();
    assert!(src.get_field(Tag::GPSLatitudeRef, In::PRIMARY).is_some());
    assert!(src.fields().any(|f| f.ifd_num == In::THUMBNAIL));

    let out_name = photo::export(folder, "a.jpg", &[], 8).unwrap();
    assert_eq!(out_name, "a_mosaic.jpg");
    let out = dir.join(&out_name);

    // 右に 90° 回して焼き込んだので縦長になり、上半分が赤（元の左半分）
    let img = image::open(&out).unwrap().into_rgb8();
    assert_eq!(img.dimensions(), (32, 64));
    let top = img.get_pixel(16, 8);
    assert!(top[0] > 150 && top[2] < 100, "上が赤くない: {top:?}");

    let exif = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(std::fs::File::open(&out).unwrap())).unwrap();
    assert!(exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY).is_none(), "GPS が残っている");
    assert!(!exif.fields().any(|f| f.ifd_num == In::THUMBNAIL), "縮小画像が残っている");
    assert_eq!(exif.get_field(Tag::Orientation, In::PRIMARY).and_then(|f| f.value.get_uint(0)), Some(1));
    assert_eq!(exif.get_field(Tag::Make, In::PRIMARY).map(|f| f.display_value().to_string()), Some("\"TestCam\"".into()));

    // 原本はそのまま
    let again = image::open(dir.join("a.jpg")).unwrap();
    assert_eq!((again.width(), again.height()), (64, 32));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pixelate_touches_only_inside_the_region() {
    let mut img = RgbImage::from_fn(100, 100, |x, y| Rgb([(x * 2) as u8, (y * 2) as u8, ((x + y) % 256) as u8]));
    let before = img.clone();
    photo::pixelate(&mut img, &[photo::Region { x: 20.0, y: 20.0, w: 40.0, h: 40.0, pad: 0.0 }], 4);
    let mut changed_inside = false;
    for (x, y, p) in img.enumerate_pixels() {
        let inside = (20..60).contains(&x) && (20..60).contains(&y);
        if inside {
            changed_inside |= p != before.get_pixel(x, y);
        } else {
            assert_eq!(p, before.get_pixel(x, y), "枠の外 ({x},{y}) が変わった");
        }
    }
    assert!(changed_inside, "枠の中が変わっていない");
}

#[test]
fn names() {
    assert!(photo::is_target("DSC0001.JPG"));
    assert!(photo::is_target("a.jpeg"));
    assert!(!photo::is_target("a_mosaic.jpg"));
    assert!(!photo::is_target("a.png"));
    assert_eq!(photo::mosaic_name("a.JPG"), "a_mosaic.jpg");
    for bad in ["", ".", "..", "../a.jpg", "sub/a.jpg", "sub\\a.jpg"] {
        assert!(photo::resolve("x", bad).is_err(), "{bad:?} を通した");
    }
}
