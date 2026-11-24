/* The POSIX calls hdfmonkey needs, on the MSVC runtime, with 64-bit offsets. */
#ifndef COMPAT_UNISTD_H
#define COMPAT_UNISTD_H
#include <stdint.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>

typedef intptr_t ssize_t;
#define off_t __int64
#define stat _stat64
#define fstat _fstat64
#define lseek _lseeki64
#define ftruncate(fd, len) (_chsize_s((fd), (len)) ? -1 : 0)

#define S_IRUSR _S_IREAD
#define S_IWUSR _S_IWRITE
#define S_IRGRP 0
#define S_IROTH 0
#endif
