use std::path::{Path, PathBuf};

fn main() {
    build_hdfmonkey();
    // Test binaries do not get the app manifest, and without Common Controls 6
    // a Tauri test exe fails to start on Windows (STATUS_ENTRYPOINT_NOT_FOUND).
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}

/// Compiles hdfmonkey for the target as the Tauri sidecar
/// binaries/ftpstar-hdfmonkey-<target>; it is a separate (GPL) program, so it
/// is never linked into FtpStar. It must exist before tauri_build runs.
fn build_hdfmonkey() {
    println!("cargo:rerun-if-changed=hdfmonkey");
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("hdfmonkey");
    let target = std::env::var("TARGET").unwrap();
    let windows = target.contains("windows");
    std::fs::create_dir_all(&out_dir).unwrap();

    let dir = root.join("hdfmonkey");
    let tool = cc::Build::new().warnings(false).debug(false).opt_level(2).static_crt(true).get_compiler();
    let msvc = tool.is_like_msvc();
    let built = out_dir.join(if windows { "hdfmonkey.exe" } else { "hdfmonkey" });

    let mut cmd = tool.to_command();
    cmd.current_dir(&out_dir).arg("-I").arg(dir.join("compat"));
    if msvc {
        cmd.arg("-I").arg(dir.join("compat").join("msvc"));
        cmd.arg("-FIunistd.h"); // its macros have to be seen by every header
        for d in ["WIN32", "main=hdfmonkey_main", "_CRT_SECURE_NO_WARNINGS", "_CRT_NONSTDC_NO_WARNINGS"] {
            cmd.arg(format!("-D{d}"));
        }
    } else {
        cmd.arg("-D_FILE_OFFSET_BITS=64");
    }
    for f in ["hdfmonkey.c", "diskio.c", "image_file.c", "ff.c", "clock.c", "ffunicode.c"] {
        cmd.arg(dir.join("src").join(f));
    }
    if msvc {
        cmd.arg(dir.join("compat").join("msvc").join("win32.c"));
        cmd.args(["-Fehdfmonkey.exe", "-link", "-Brepro", "-SUBSYSTEM:CONSOLE"]);
    } else {
        cmd.arg("-o").arg(&built);
    }
    let out = cmd.output().unwrap_or_else(|e| panic!("hdfmonkey: cannot run {:?}: {e}", tool.path()));
    assert!(
        out.status.success(),
        "hdfmonkey: the C compiler failed ({})\n{}{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let sidecar = root.join("binaries").join(format!("ftpstar-hdfmonkey-{target}{}", if windows { ".exe" } else { "" }));
    copy_if_changed(&built, &sidecar);
    // for tests/nextsd.rs
    println!("cargo:rustc-env=FTPSTAR_BUILT_HDFMONKEY={}", built.display());
}

/// An unchanged file keeps its date, so it does not start a new build.
fn copy_if_changed(from: &Path, to: &Path) {
    if std::fs::read(to).ok() != Some(std::fs::read(from).unwrap()) {
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(from, to).unwrap();
    }
}
