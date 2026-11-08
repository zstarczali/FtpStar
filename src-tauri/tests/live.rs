//! Tests against the public read-only test server test.rebex.net
//! (user "demo", password "password"). They need the internet, so they are
//! ignored by default: `cargo test -- --ignored`.

use ftpstar_lib::conn::Conn;
use ftpstar_lib::settings::Site;
use ftpstar_lib::xfer::Progress;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn site(protocol: &str) -> Site {
    Site { protocol: protocol.into(), host: "test.rebex.net".into(), user: "demo".into(), ..Default::default() }
}

async fn exercise(conn: Conn, home: &str) {
    let list = conn.list(home).await.expect("list");
    assert!(list.iter().any(|e| e.name == "readme.txt" && !e.dir), "readme.txt in {home}: {list:?}");
    assert!(list.iter().any(|e| e.name == "pub" && e.dir), "pub folder");
    // a missing folder is an error, not an empty listing
    let missing = conn.list(&ftpstar_lib::xfer::join(home, "pub/no-such-folder")).await;
    assert!(missing.is_err(), "missing folder listed as {missing:?}");
    // and the session still works after it
    assert!(!conn.list(&ftpstar_lib::xfer::join(home, "pub")).await.expect("list pub").is_empty());
    let tmp = std::env::temp_dir().join(format!("ftpstar-test-{}.txt", std::process::id()));
    let local = tmp.display().to_string();
    let p = Progress::new(None, "t".into(), 0, Arc::new(AtomicBool::new(false)));
    conn.download(&ftpstar_lib::xfer::join(home, "readme.txt"), &local, p.clone()).await.expect("download");
    let text = std::fs::read_to_string(&tmp).unwrap();
    assert!(text.contains("Welcome"), "readme content: {text}");
    assert_eq!(p.done(), text.len() as u64);
    let _ = std::fs::remove_file(&tmp);
    let walked = conn.walk(&ftpstar_lib::xfer::join(home, "pub")).await.expect("walk");
    assert!(!walked.is_empty());
    // a cancelled transfer stops with CANCELLED
    let p = Progress::new(None, "c".into(), 0, Arc::new(AtomicBool::new(true)));
    let r = conn.download(&ftpstar_lib::xfer::join(home, "readme.txt"), &local, p).await;
    assert_eq!(r.unwrap_err(), ftpstar_lib::xfer::CANCELLED);
    assert!(!tmp.exists(), "partial file removed");
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn ftp_rebex() {
    let (c, home) = ftpstar_lib::ftp::Ftp::open(site("ftp"), "password".into()).await.expect("connect");
    exercise(Conn::Ftp(c), &home).await;
}

#[tokio::test]
#[ignore]
async fn ftps_explicit_rebex() {
    let (c, home) = ftpstar_lib::ftp::Ftp::open(site("ftps"), "password".into()).await.expect("connect");
    exercise(Conn::Ftp(c), &home).await;
}

#[tokio::test]
#[ignore]
async fn sftp_rebex() {
    // first attempt: unknown host key
    let err = ftpstar_lib::sftp::Sftp::open(&site("sftp"), "password", None, None).await.err().expect("must ask about the key");
    assert!(err.starts_with("HOSTKEY_UNKNOWN:SHA256:"), "{err}");
    let fp = err.trim_start_matches("HOSTKEY_UNKNOWN:").to_string();
    // a wrong saved key is refused
    let err = ftpstar_lib::sftp::Sftp::open(&site("sftp"), "password", Some("SHA256:wrong".into()), None).await.err().unwrap();
    assert!(err.starts_with("HOSTKEY_CHANGED:"), "{err}");
    let o = ftpstar_lib::sftp::Sftp::open(&site("sftp"), "password", None, Some(fp.clone())).await.expect("connect");
    assert_eq!(o.new_fingerprint.as_deref(), Some(fp.as_str()));
    exercise(Conn::Sftp(o.conn), &o.home).await;
}

#[test]
fn mlsd_lines() {
    use ftpstar_lib::ftp::parse_mlsd;
    let e = parse_mlsd("type=file;size=1234;modify=20240102030405;UNIX.mode=0644; my file.txt").unwrap();
    assert_eq!((e.name.as_str(), e.dir, e.size), ("my file.txt", false, 1234));
    assert_eq!(e.perms.as_deref(), Some("rw-r--r--"));
    assert_eq!(e.mtime, Some(1704164645));
    let d = parse_mlsd("Type=dir;Modify=20240102030405.123;Perm=flcdmpe; public_html").unwrap();
    assert!(d.dir && d.name == "public_html");
    assert!(parse_mlsd("type=cdir;modify=20240102030405; .").is_none());
    assert!(parse_mlsd("type=pdir; ..").is_none());
}

#[test]
fn local_copy_tree() {
    let dir = std::env::temp_dir().join(format!("ftpstar-copy-{}", std::process::id()));
    let src = dir.join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.txt"), "a").unwrap();
    std::fs::write(src.join("sub").join("b.txt"), "b").unwrap();
    ftpstar_lib::commands::copy_tree(&src, &dir.join("dst")).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("dst").join("sub").join("b.txt")).unwrap(), "b");
    // into itself: refused
    assert!(ftpstar_lib::commands::copy_tree(&src, &src.join("sub").join("again")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
