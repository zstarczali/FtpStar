/* Windows side of hdfmonkey: UTF-8 arguments and file names, directory
   reading. Names are UTF-8 everywhere: wmain converts the arguments, and the
   UTF-8 locale makes fopen, open, stat and mkdir read them as UTF-8. */
#undef main /* build.rs renames the main of hdfmonkey.c */
#include <windows.h>
#include <locale.h>
#include <stdlib.h>
#include <string.h>
#include "dirent.h"
#include "libgen.h"

int hdfmonkey_main(int argc, char *argv[]);

int wmain(int argc, wchar_t *wargv[]) {
	int i, n;
	char **argv = calloc(argc + 1, sizeof(char *));

	if (!argv) return 1;
	for (i = 0; i < argc; i++) {
		n = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
		if (n <= 0 || !(argv[i] = malloc(n))) return 1;
		WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, argv[i], n, NULL, NULL);
	}
	setlocale(LC_CTYPE, ".UTF8");
	return hdfmonkey_main(argc, argv);
}

char *basename(char *path) {
	char *p, *base = path;

	for (p = path; *p; p++) {
		if ((*p == '/' || *p == '\\') && p[1]) base = p + 1;
	}
	return base;
}

struct compat_dir {
	HANDLE handle;
	int first;
	WIN32_FIND_DATAW data;
	struct dirent entry;
};

DIR *opendir(const char *path) {
	wchar_t *pattern;
	int n;
	DIR *dir;

	n = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
	if (n <= 0 || !(pattern = malloc((n + 2) * sizeof(wchar_t)))) return NULL;
	MultiByteToWideChar(CP_UTF8, 0, path, -1, pattern, n);
	wcscpy_s(pattern + n - 1, 3, L"\\*");
	dir = calloc(1, sizeof(DIR));
	if (dir) {
		dir->handle = FindFirstFileW(pattern, &dir->data);
		dir->first = 1;
		if (dir->handle == INVALID_HANDLE_VALUE) {
			free(dir);
			dir = NULL;
		}
	}
	free(pattern);
	return dir;
}

struct dirent *readdir(DIR *dir) {
	if (!dir->first && !FindNextFileW(dir->handle, &dir->data)) return NULL;
	dir->first = 0;
	if (!WideCharToMultiByte(CP_UTF8, 0, dir->data.cFileName, -1, dir->entry.d_name, sizeof(dir->entry.d_name), NULL, NULL)) return NULL;
	return &dir->entry;
}

int closedir(DIR *dir) {
	FindClose(dir->handle);
	free(dir);
	return 0;
}
