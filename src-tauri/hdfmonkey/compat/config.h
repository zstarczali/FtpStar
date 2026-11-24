/* Replaces the config.h of autoconf; the program is built by ../../build.rs. */
#ifndef HDFMONKEY_CONFIG_H
#define HDFMONKEY_CONFIG_H
#define PACKAGE_VERSION "0.5.4-ftpstar"
#define VERSION PACKAGE_VERSION
#ifdef _WIN32
#define COMPAT_WIN32 1
#endif
#endif
