//! ZX Spectrum Next SD image through hdfmonkey, on new images made with the
//! hdfmonkey built by build.rs. FTPSTAR_HDFMONKEY can point at another one.

use ftpstar_lib::conn::Conn;
use ftpstar_lib::nextsd::NextSd;
use ftpstar_lib::settings::Site;
use ftpstar_lib::xfer::Progress;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn p() -> Progress {
    Progress::new(None, "t".into(), 0, Arc::new(AtomicBool::new(false)))
}

/// A temporary folder (with an accented name) and a new image in it.
fn image(name: &str, size: &str) -> (PathBuf, Site, String) {
    let tool = std::env::var("FTPSTAR_HDFMONKEY").unwrap_or_else(|_| env!("FTPSTAR_BUILT_HDFMONKEY").into());
    let tmp = std::env::temp_dir().join(format!("ftpstar-sdkép-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let img = tmp.join("tűkör.img").display().to_string();
    let out = std::process::Command::new(&tool).args(["create", &img, size]).output().expect("hdfmonkey");
    assert!(out.status.success(), "{out:?}");
    (tmp, Site { protocol: "nextsd".into(), sd_image: img, ..Default::default() }, tool)
}

#[tokio::test]
async fn round_trip() {
    let (tmp, site, tool) = image("round-trip", "64M");
    let (sd, home) = NextSd::open(&site, &tool).await.expect("open");
    assert_eq!(home, "/");
    let c = Conn::NextSd(sd);

    let dir = std::env::temp_dir().join(format!("ftpstar-nextsd-testő-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.txt");
    std::fs::write(&src, b"hello next").unwrap();
    let src = src.display().to_string();

    let _ = c.remove("/t1", true).await;
    let _ = c.remove("/t2", true).await;
    c.mkdir("/t1").await.unwrap();
    c.mkdir("/t1/sub dir").await.unwrap();
    let up = p();
    c.upload(&src, "/t1/sub dir/Árvíztűrő.txt", up.clone()).await.unwrap();
    assert_eq!(up.done(), 10);
    c.upload(&src, "/t1/a.txt", p()).await.unwrap();
    let l = c.list("/t1").await.unwrap();
    assert_eq!(l.iter().map(|e| (e.name.as_str(), e.dir)).collect::<Vec<_>>(), vec![("sub dir", true), ("a.txt", false)]);
    assert_eq!(l[1].size, 10);
    assert_eq!(c.list("/t1/sub dir").await.unwrap()[0].name, "Árvíztűrő.txt");
    assert!(c.list("/no-such-folder").await.is_err());

    c.rename("/t1/a.txt", "/t1/b.txt", false).await.unwrap();
    c.rename("/t1/b.txt", "/t1/B.txt", false).await.unwrap(); // case only
    assert!(c.rename("/t1/B.txt", "/t1/sub dir", false).await.is_err()); // target exists
    c.rename("/t1", "/t2", true).await.unwrap();
    assert!(c.list("/t1").await.is_err());
    let names: Vec<_> = c.list("/t2").await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["sub dir", "B.txt"]);
    let walk: Vec<_> = c.walk("/t2").await.unwrap().into_iter().map(|w| w.rel).collect();
    assert_eq!(walk, vec!["B.txt", "sub dir", "sub dir/Árvíztűrő.txt"]);

    let out = dir.join("out.txt").display().to_string();
    let down = p();
    c.download("/t2/sub dir/Árvíztűrő.txt", &out, down.clone()).await.unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), b"hello next");
    assert_eq!(down.done(), 10);
    assert!(c.download("/t2/nope.txt", &out, p()).await.is_err());

    c.remove("/t2", true).await.unwrap();
    assert!(!c.list("/").await.unwrap().iter().any(|e| e.name == "t2"));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A file that does not fit is an error and leaves nothing behind.
#[tokio::test]
async fn full_image() {
    let (tmp, site, tool) = image("full", "1M");
    let c = Conn::NextSd(NextSd::open(&site, &tool).await.expect("open").0);
    let big = tmp.join("big.bin");
    std::fs::write(&big, vec![7u8; 2 << 20]).unwrap();
    assert!(c.upload(&big.display().to_string(), "/big.bin", p()).await.is_err());
    assert!(c.list("/").await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

/// Data past 4 GB of the image is written and read back.
#[tokio::test]
#[ignore = "fills 4.5 GB of disk"]
async fn large_image() {
    let (tmp, site, tool) = image("large", "6G");
    let c = Conn::NextSd(NextSd::open(&site, &tool).await.expect("open").0);
    let (src, out) = (tmp.join("src.bin"), tmp.join("out.bin"));
    for i in 0..18u32 {
        let data: Vec<u8> = (0..(256u32 << 20) / 4).flat_map(|n| (n ^ (i << 26)).to_le_bytes()).collect();
        std::fs::write(&src, data).unwrap();
        c.upload(&src.display().to_string(), &format!("/f{i}.bin"), p()).await.unwrap();
    }
    for i in [0u32, 8, 17] {
        c.download(&format!("/f{i}.bin"), &out.display().to_string(), p()).await.unwrap();
        let data = std::fs::read(&out).unwrap();
        assert_eq!(data.len(), 256 << 20);
        assert!(data.chunks(4).enumerate().all(|(n, b)| b == (n as u32 ^ (i << 26)).to_le_bytes()), "f{i}");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
