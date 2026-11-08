<p align="center"><img src="assets/icon.svg" width="120" alt="FtpStar"></p>

# FtpStar

A two-pane file transfer client for **FTP, FTPS, SFTP, Amazon S3 (and S3-compatible storage) and Microsoft OneDrive**, built with Tauri 2 and Rust. A sibling of [GitStar](https://github.com/zstarczali/GitStar): the same look, the same themes.

Current version **0.1.0**.

## Features

- **Protocols**
  - FTP, FTPS with explicit TLS (AUTH TLS) and implicit TLS (port 990), passive or active mode. The data connection resumes the control connection's TLS session, which FileZilla Server and vsftpd require.
  - SFTP (SSH) in pure Rust (russh): private keys (ed25519, ECDSA, RSA, with passphrase), the default keys in `~/.ssh`, password as a fallback. The first connection shows the server's key fingerprint for confirmation; a changed key is refused.
  - Amazon S3, plus Cloudflare R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces… through a custom endpoint and path-style addressing.
  - Microsoft OneDrive through Microsoft Graph with device-code sign-in; large files go up in 5 MiB pieces of an upload session.
- **Two panes**: local files on the left, the server on the right, a tab for every connection (with a colour per site).
- **Transfer queue**: parallel transfers per connection, progress, speed and time left, stop, retry failed. Folders are transferred with everything in them.
- **Drag and drop** between the panes or onto a folder, and from Explorer / Finder onto the remote pane.
- **When the target exists**: ask, overwrite, skip, or only newer files.
- **Compare**: highlights files that exist only on one side, differ, or are newer; one click selects them for transfer.
- **Edit a remote file**: opens it in its default app and uploads it again whenever it is saved.
- **Site Manager** with folders, search, duplicate, notes, start folders; **Quick connect**.
- Total Commander style keys: Tab, Enter, Backspace, Space/Insert, F2, F5, F7, Del, Ctrl+A, Ctrl+R; typing jumps to a name.
- Themes from GitStar (dark, light, AI neon, retro, modern glass), Hungarian and English UI, zoom.

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

## License

Freeware, © 2026 Zsolt Tarczali. See [LICENSE](LICENSE).
