#ifndef COMPAT_DIRENT_H
#define COMPAT_DIRENT_H
struct dirent { char d_name[1024]; };
typedef struct compat_dir DIR;
DIR *opendir(const char *path);
struct dirent *readdir(DIR *dir);
int closedir(DIR *dir);
#endif
