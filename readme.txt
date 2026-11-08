FtpStar Installation Guide
==========================

Version 0.1.1
-------------
A two-pane FTP, FTPS, SFTP, Amazon S3 (and S3-compatible) and Microsoft
OneDrive client with a transfer queue, folder compare and remote
editing. A sibling of GitStar.

New in 0.1.1: Settings > General > Network timeout (5-600 seconds) for
connecting and for a stalled transfer; raise it for a slow server.
Large S3 transfers are no longer cut off after 60 seconds.

The main-window Donate button appears after 10 minutes of foreground
use. The timer pauses while the window is unfocused or hidden and
resets each time FtpStar starts. You can also donate from the About
dialog at any time.

See whatsnew.txt for the release history.

Download
--------
On the GitHub Actions page for a successful "Build installers" run,
download the ZIP for your platform from Artifacts and extract it.

Windows x64 and ARM64
---------------------
1. Open Settings > System > About and check System type.
2. For an x64 processor, choose the NSIS .exe from the
   FtpStar-x86_64-pc-windows-msvc artifact. For an ARM processor, choose
   the .exe from FtpStar-aarch64-pc-windows-msvc.
3. Run the FtpStar .exe installer. If the WebView2 Runtime is missing,
   the installer downloads it, which requires an internet connection.
   SmartScreen may warn about the unsigned installer. If you have
   verified the download source, select "More info" and then "Run anyway"
   if Windows offers that option.
4. Open FtpStar from the Start menu.

macOS Apple Silicon (ARM64) and Intel (x64)
------------------------------------------
1. Open Apple menu > About This Mac and check the chip or processor.
   For an Apple M-series chip, choose the .dmg from
   FtpStar-aarch64-apple-darwin. For an Intel processor, choose the .dmg
   from FtpStar-x86_64-apple-darwin.
2. Open the .dmg, drag FtpStar.app into Applications, and eject the disk
   image.
3. Open FtpStar from Applications. If Gatekeeper blocks the app because
   the developer cannot be verified, check the download source. After
   the first launch attempt, open System Settings > Privacy & Security,
   choose "Open Anyway" if available, and confirm.
   Apple guide: https://support.apple.com/en-ie/102445
4. If macOS says that "FtpStar is damaged and can't be opened", or
   "Open Anyway" does not appear, remove the quarantine flag that macOS
   puts on downloaded files. The app is not signed by Apple, so macOS
   blocks it. Run this in Terminal after copying the app to
   Applications:

     xattr -dr com.apple.quarantine /Applications/FtpStar.app

   If it still does not open, clear all extended attributes:

     xattr -cr /Applications/FtpStar.app

   Then open FtpStar from Applications again. Repeat this after
   installing a new version, including one installed by the self-update.

Linux x64
---------
Run "uname -m" and confirm that it reports x86_64. The
FtpStar-x86_64-unknown-linux-gnu artifact contains three formats.
Run the commands from the download folder and replace the example
filenames with the actual filenames.

Debian or Ubuntu (.deb)
  sudo apt update
  sudo apt install ./FtpStar_amd64.deb
  Open FtpStar from the application menu.

Fedora or another DNF-based distribution (.rpm)
  sudo dnf install ./FtpStar.x86_64.rpm
  Open FtpStar from the application menu.

AppImage
  chmod +x ./FtpStar_amd64.AppImage
  ./FtpStar_amd64.AppImage

  If you get a FUSE error, install your distribution's FUSE 2
  compatibility package (libfuse2 on Ubuntu 22.04 or libfuse2t64 on
  Ubuntu 24.04), or try:
  ./FtpStar_amd64.AppImage --appimage-extract-and-run

First connection
----------------
Open Sites (Ctrl+S), choose New, pick the protocol and fill in the
server, user name and password (leave the password empty to be asked
when connecting), then Connect. Quick (Ctrl+Q) connects without saving.

SFTP: the first connection shows the server's key fingerprint; accept it
only if it matches the server. A changed key is refused.

FTPS: choose "FTPS (explicit)" for servers that use AUTH TLS on port 21,
or "FTPS (implicit)" for port 990.

OneDrive needs an Azure app (client) ID once: see README.md or
Settings > Cloud. Amazon S3 and S3-compatible services (R2, MinIO,
Wasabi...) take the access keys per site in the Site Manager.

Using it
--------
Double-click (or Enter) opens a file: a remote file is downloaded to a
temporary copy and uploaded again whenever it is saved. F5, the
Upload / Download buttons or dragging transfer the selection to the
other pane. Files copied in Explorer / Finder can be pasted with Ctrl+V
to upload them.

Update
------
FtpStar looks for a new version at start (Settings > Update). The
server address is enough (https://www.c64va.pro/); the installers are
looked up in its downloads/FtpStar/ folder.

Where the data is
-----------------
settings.json, sites.json and known_hosts.json are in the app's
configuration folder (About > Settings folder). Saved passwords are
stored in sites.json on this computer.
