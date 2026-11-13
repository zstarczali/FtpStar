<p align="center"><img src="assets/icon.svg" width="200" height="200" alt="FtpStar"></p>

# FtpStar

<!-- badges:start -->
<p align="center">
  <a href="https://www.c64va.pro/ftpstar.html"><img src="https://img.shields.io/badge/website-c64va.pro-e05d44?style=flat" alt="Website"></a>
  <a href="https://github.com/zstarczali/FtpStar/blob/main/package.json"><img src="https://img.shields.io/github/package-json/v/zstarczali/FtpStar/main?label=version&color=4c1" alt="Version"></a>
  <a href="https://github.com/zstarczali/FtpStar/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/zstarczali/FtpStar/build.yml?branch=main&label=build" alt="Build"></a>
  <a href="https://github.com/zstarczali/FtpStar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-freeware-blue" alt="License: Freeware"></a>
  <a href="https://www.c64va.pro/register/donate.php"><img src="https://img.shields.io/badge/donate-PayPal-00457C?logo=paypal&logoColor=white" alt="Donate"></a>
</p>
<p align="center">
  <a href="https://v2.tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white" alt="Tauri 2"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-backend-B7410E?logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://www.c64va.pro/ftpstar.html"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Platforms"></a>
  <a href="https://github.com/zstarczali/FtpStar/commits/main"><img src="https://img.shields.io/github/last-commit/zstarczali/FtpStar/main" alt="Last commit"></a>
  <a href="https://github.com/zstarczali/FtpStar/graphs/commit-activity"><img src="https://img.shields.io/github/commit-activity/m/zstarczali/FtpStar" alt="Commit activity"></a>
  <a href="https://github.com/zstarczali/FtpStar/issues"><img src="https://img.shields.io/github/issues/zstarczali/FtpStar" alt="Issues"></a>
  <a href="https://github.com/zstarczali/FtpStar/stargazers"><img src="https://img.shields.io/github/stars/zstarczali/FtpStar?style=flat" alt="Stars"></a>
</p>
<p align="center">
  <a href="https://github.com/zstarczali/FtpStar#readme"><img src="https://img.shields.io/badge/English-ddd" alt="English"></a>
  <a href="https://github.com/zstarczali/FtpStar#readme"><img src="https://img.shields.io/badge/Magyar-ddd" alt="Magyar"></a>
  <a href="https://github.com/zstarczali/GitStar"><img src="https://img.shields.io/badge/sibling-GitStar-8a2be2" alt="GitStar"></a>
  <a href="https://github.com/zstarczali/DiffStar"><img src="https://img.shields.io/badge/sibling-DiffStar-8a2be2" alt="DiffStar"></a>
</p>
<!-- badges:end -->

A two-pane file transfer client for **FTP, FTPS, SFTP, Amazon S3 (and S3-compatible storage) and Microsoft OneDrive**, built with Tauri 2 and Rust. A sibling of [GitStar](https://github.com/zstarczali/GitStar): the same look, the same themes.

Current version **0.4.4** · **[Website and downloads](https://www.c64va.pro/ftpstar.html)** · [Installation guide](readme.txt) · [What's new](whatsnew.txt)

Windows x64 and ARM64, macOS (Apple Silicon and Intel), Linux (AppImage, .deb, .rpm). Freeware.


## Features

- **Protocols**
  - FTP, FTPS with explicit TLS (AUTH TLS) and implicit TLS (port 990), passive or active mode. The data connection resumes the control connection's TLS session, which FileZilla Server and vsftpd require.
  - SFTP (SSH) in pure Rust (russh): private keys (ed25519, ECDSA, RSA, with passphrase), the default keys in `~/.ssh`, password as a fallback. The first connection shows the server's key fingerprint for confirmation; a changed key is refused.
  - Amazon S3, plus Cloudflare R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces… through a custom endpoint and path-style addressing.
  - Microsoft OneDrive through Microsoft Graph with device-code sign-in; large files go up in 5 MiB pieces of an upload session.
- **Two panes**: local files on the left, the server on the right, a tab for every connection (with a colour per site).
- **Views**: details, small icons or large icons per pane, with **image thumbnails** (also for files on the server).
- **Transfer queue**: parallel transfers per connection, progress, speed and time left, stop, retry failed. While the queue is hidden, the status bar shows the overall progress. Folders are transferred with everything in them.
- **Cut, copy and paste** (Ctrl+X / C / V) in both panes: copy or move within a side, upload or download between the sides, server to server between tabs. Files copied in FtpStar can be pasted in Explorer / Finder and the other way round.
- **Drag and drop** between the panes or onto a folder, and from Explorer / Finder onto the remote pane.
- **Properties** (right-click or Alt+Enter): size with folder totals, date, permissions, URL and an image preview.
- **When the target exists**: ask, overwrite, skip, or only newer files.
- **Copy only the new files** from one side to the other, with subfolders (optionally the newer ones too); a dialog lists what will be copied first.
- **Compare**: highlights files that exist only on one side, differ, or are newer; one click selects them for transfer.
- **Double-click opens a file**; a remote file opens from a temporary copy and is uploaded again whenever it is saved.
- **Site Manager** with folders, search, duplicate, notes, start folders; **Quick connect**.
- Total Commander style keys: Tab, Enter, Backspace, Space/Insert, F2, F5, F7, Del, Ctrl+A, Ctrl+R; typing jumps to a name.
- Themes from GitStar (dark, light, AI neon, retro, modern glass), Hungarian and English UI, zoom.
- **Self-update** from the website; closing a tab asks first.

## OneDrive setup (one time)

OneDrive sign-in needs an Azure app registration (free):

1. [portal.azure.com](https://portal.azure.com) → **App registrations** → **New registration**. Supported account types: *any organizational directory and personal Microsoft accounts*.
2. **Authentication** → **Allow public client flows** = **Yes**.
3. **API permissions**: `Files.ReadWrite.All`, `offline_access`, `User.Read` (Microsoft Graph, delegated).
4. Copy the **Application (client) ID** into FtpStar → Settings → Cloud.

Then create a OneDrive site in the Site Manager and press **Sign in with a Microsoft account**.

## Where the data is

`settings.json`, `sites.json` and `known_hosts.json` are in the app's configuration folder (About → Settings folder). Saved passwords and keys are stored in `sites.json` on this computer; leave the password empty to be asked when connecting.

## Building

Requirements: Rust (stable), Node.js, and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```
npm install
npm run dev      # development
npm run build    # installers in src-tauri/target/release/bundle
```

Tests: `cargo test` in `src-tauri`; `cargo test -- --ignored` also runs the FTP, FTPS and SFTP tests against the public test server test.rebex.net.

## Releases

GitHub Actions, started by hand:

1. **Build installers** (`.github/workflows/build.yml`) builds every platform; the installers are the run's artifacts.
2. **Publish** (`.github/workflows/publish.yml`) takes a successful build's run ID and uploads the installers and the installation guide to the download folder over FTPS (needs the `FTP_PASSWORD` secret). The app's self-update reads that folder.

## Feedback

Bug reports and ideas are welcome in [Issues](https://github.com/zstarczali/FtpStar/issues).

## License

Freeware, © 2026 Zsolt Tarczali. See [LICENSE](LICENSE). The source is public for reference; redistribution and derivative works need permission (see the license). Download the installers from the [website](https://www.c64va.pro/ftpstar.html).
