//! Thumbnails of image files for the icon views: a small JPEG / PNG as a data
//! URL. Remote images are downloaded to a cache folder first.

use base64::Engine;
use image::ImageFormat;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// Local images bigger than this are not decoded (a thumbnail is not worth it).
const MAX_LOCAL: u64 = 60 * 1024 * 1024;
/// Remote images bigger than this are not downloaded for a thumbnail.
pub const MAX_REMOTE: u64 = 20 * 1024 * 1024;
/// SVG files are shown as they are, up to this size.
const MAX_SVG: u64 = 2 * 1024 * 1024;

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn is_svg(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("svg"))
}

/// A thumbnail at most `size` pixels on its longer side.
pub fn make(path: &Path, size: u32) -> Result<String, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if is_svg(path) {
        if len > MAX_SVG {
            return Err("too large".into());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        return Ok(data_url("image/svg+xml", &bytes));
    }
    if len > MAX_LOCAL {
        return Err("too large".into());
    }
    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let size = size.clamp(16, 512);
    let small = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let mut out = Cursor::new(Vec::new());
    if small.color().has_alpha() {
        small.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(data_url("image/png", out.get_ref()))
    } else {
        small.into_rgb8().write_to(&mut out, ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        Ok(data_url("image/jpeg", out.get_ref()))
    }
}

/// Where a remote image is cached: named after the server, path, size and date,
/// so a changed file is downloaded again.
pub fn cache_file(server: &str, path: &str, size: u64, mtime: i64) -> PathBuf {
    let mut h = Sha256::new();
    h.update(format!("{server}\n{path}\n{size}\n{mtime}"));
    let name = format!("{:x}", h.finalize());
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).filter(|e| e.len() <= 5).unwrap_or_default();
    std::env::temp_dir().join("FtpStar").join("thumbs").join(format!("{}.{ext}", &name[..32]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_and_jpeg_thumbnails() {
        let dir = std::env::temp_dir().join(format!("ftpstar-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.png");
        image::RgbaImage::from_pixel(400, 200, image::Rgba([10, 20, 30, 128])).save(&png).unwrap();
        let jpg = dir.join("b.jpg");
        image::RgbImage::from_pixel(50, 80, image::Rgb([200, 0, 0])).save(&jpg).unwrap();
        let svg = dir.join("c.svg");
        std::fs::write(&svg, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();

        let a = make(&png, 96).unwrap();
        assert!(a.starts_with("data:image/png;base64,"));
        let bytes = base64::engine::general_purpose::STANDARD.decode(a.split_once(',').unwrap().1).unwrap();
        let t = image::load_from_memory(&bytes).unwrap();
        assert_eq!((t.width(), t.height()), (96, 48));
        assert!(make(&jpg, 96).unwrap().starts_with("data:image/jpeg;base64,"));
        assert!(make(&svg, 96).unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(make(&dir.join("missing.png"), 96).is_err());
        let not_image = dir.join("d.png");
        std::fs::write(&not_image, "hello").unwrap();
        assert!(make(&not_image, 96).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_names_change_with_the_file() {
        let a = cache_file("s", "/x/p.JPG", 10, 1);
        assert!(a.to_string_lossy().ends_with(".jpg"));
        assert_ne!(a, cache_file("s", "/x/p.JPG", 11, 1));
        assert_ne!(a, cache_file("t", "/x/p.JPG", 10, 1));
    }
}
