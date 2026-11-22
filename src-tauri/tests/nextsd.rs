//! ZX Spectrum Next SD image through hdfmonkey. It writes to the image, so it
//! runs only when FTPSTAR_NEXTSD_TEST names a throwaway image
//! (e.g. `hdfmonkey create t.img 64M`); FTPSTAR_HDFMONKEY can point at the
//! tool, otherwise the one next to the image or on the PATH is used.

use ftpstar_lib::conn::Conn;
use ftpstar_lib::nextsd::NextSd;
use ftpstar_lib::settings::Site;
use ftpstar_lib::xfer::Progress;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn p() -> Progress {
    Progress::new(None, "t".into(), 0, Arc::new(AtomicBool::new(false)))
}

#[tokio::test]
async fn round_trip() {
    let Ok(img) = std::env::var("FTPSTAR_NEXTSD_TEST") else { return };
    let site = Site { protocol: "nextsd".into(), sd_image: img, hdfmonkey: std::env::var("FTPSTAR_HDFMONKEY").unwrap_or_default(), ..Default::default() };
    let (sd, home) = NextSd::open(&site).await.expect("open");
    assert_eq!(home, "/");
    let c = Conn::NextSd(sd);

    let dir = std::env::temp_dir().join(format!("ftpstar-nextsd-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.txt");
    std::fs::write(&src, b"hello next").unwrap();
    let src = src.display().to_string();

    let _ = c.remove("/t1", true).await;
    let _ = c.remove("/t2", true).await;
    c.mkdir("/t1").await.unwrap();
    c.mkdir("/t1/sub dir").await.unwrap();
    let up = p();
    c.upload(&src, "/t1/sub dir/Árvíz.txt", up.clone()).await.unwrap();
    assert_eq!(up.done(), 10);
    c.upload(&src, "/t1/a.txt", p()).await.unwrap();
    let l = c.list("/t1").await.unwrap();
    assert_eq!(l.iter().map(|e| (e.name.as_str(), e.dir)).collect::<Vec<_>>(), vec![("sub dir", true), ("a.txt", false)]);
    assert_eq!(l[1].size, 10);
    assert_eq!(c.list("/t1/sub dir").await.unwrap()[0].name, "Árvíz.txt");
    assert!(c.list("/no-such-folder").await.is_err());

    c.rename("/t1/a.txt", "/t1/b.txt", false).await.unwrap();
    c.rename("/t1/b.txt", "/t1/B.txt", false).await.unwrap(); // case only
    assert!(c.rename("/t1/B.txt", "/t1/sub dir", false).await.is_err()); // target exists
    c.rename("/t1", "/t2", true).await.unwrap();
    assert!(c.list("/t1").await.is_err());
    let names: Vec<_> = c.list("/t2").await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["sub dir", "B.txt"]);
    let walk: Vec<_> = c.walk("/t2").await.unwrap().into_iter().map(|w| w.rel).collect();
    assert_eq!(walk, vec!["B.txt", "sub dir", "sub dir/Árvíz.txt"]);

    let out = dir.join("out.txt").display().to_string();
    let down = p();
    c.download("/t2/sub dir/Árvíz.txt", &out, down.clone()).await.unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), b"hello next");
    assert_eq!(down.done(), 10);
    assert!(c.download("/t2/nope.txt", &out, p()).await.is_err());

    c.remove("/t2", true).await.unwrap();
    assert!(!c.list("/").await.unwrap().iter().any(|e| e.name == "t2"));
    let _ = std::fs::remove_dir_all(&dir);
}
