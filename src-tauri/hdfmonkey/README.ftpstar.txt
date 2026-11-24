hdfmonkey, as bundled with FtpStar
==================================

hdfmonkey is (C) Matt Westcott and contributors, and is licensed under the
GNU General Public License version 3: see COPYING. The FAT driver in it is
FatFs, (C) ChaN, under its own permissive license (see src/ff.c).

FtpStar is a separate, MIT-licensed program. It only runs hdfmonkey as an
external command (the installed file is called ftpstar-hdfmonkey).

Origin:   https://codeberg.org/chwe/hdfmonkey, commit 5fb0a94 (0.5.4 + FatFs R0.16)
          (a continuation of https://github.com/gasman/hdfmonkey)
Source of this build: src-tauri/hdfmonkey and src-tauri/build.rs in
          https://github.com/zstarczali/FtpStar

Changes made for FtpStar (November 2026):
- ffconf.h: file names are UTF-8 (FF_LFN_UNICODE 2), FF_LFN_BUF 768
- put: a full image, a failed close or a failed file of a folder is an error;
  the partial file is removed
- ls: sizes over 2 GB are not negative
- get: errors writing the local file are reported
- clone: static buffer, 64-bit size; image_file.c, diskio.c: 64-bit offsets
- compat/: config.h without autoconf, and what MSVC needs
- removed: autoconf and Debian files, patches, tests, the unused mbr.c, integer.h
