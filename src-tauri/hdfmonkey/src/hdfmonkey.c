/*
    hdfmonkey: A Swiss Army Knife for manipulating HDF disk images
    Copyright (C) 2010 Matt Westcott

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/* The following changes required for FatFs (see FatFs.r15.patch):
   - ffconfig.h
	- FF_USE_FIND 1
	- FF_USE_MKFS 1
	- FF_USE_LABEL 1
	- FF_CODE_PAGE 850 (Latin 1)
	- FF_USE_LFN 1
	- FF_VOLUMES 2
   - ff.h
	- add 'TCHAR label[11];        // Volume label (11 chars max) ' to MKFS_PARM
   - ff.c
	- initialise MKFS_PARM.label in f_mkfs ', "           " };'
	- after memcpy(buf + BS_VolLab32, ... add 'if (opt->label[0]) memcpy(buf+BS_VolLab32, opt->label, 11);'
	- after memcpy(buf + BS_VolLab, ... add the following:
		- if (fsty == FS_FAT12) memcpy(buf+BS_FilSysType+3, "12", 2);
		- else memcpy(buf+BS_FilSysType+3, "16", 2);
		- if (opt->label[0]) memcpy(buf+BS_VolLab, opt->label, 11);
    Also check N_SEC_TRACK in ff.h, if it is not equal to 63 then adjust below
 */

#include <config.h>

#define DIR FATDIR
#include "ff.h"
#undef DIR

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <libgen.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>

// MS Windows has no mkdir(path, mode), use _mkdir(path) instead
#if defined(WIN32) || defined(WIN64)
#include <direct.h>
#define mkdir(p, m) _mkdir(p)
#endif

#include "image_file.h"
#include "diskio.h"

#include "ffconf.h"

static const char DRV_0[] = "0:";
static const char DRV_1[] = "1:";

// made up Filesystem type, used by cmd_rebuild
#define FS_SAME 0xff
// not exposed by FatFs, make sure it's in sync with ff.c
#define N_SEC_TRACK 63

#if defined(__MINGW32__) || defined(__MINGW64__)
extern int _dowildcard; // https://www.msys2.org/docs/c/#expanding-wildcard-arguments
#define HDF_MINGW_WILDCARD
#endif

// arbitrary string to be shown after version number
// intended to enumerate optional features compiled in
#ifdef HDF_USE_WINAPI
#ifdef WIN64
#define IDTAG " w64/sparse"
#else
#define IDTAG " w32/sparse"
#endif
#else
#define IDTAG
#endif

#define BUFFER_SIZE 2048
#define CLONE_BUFFER_SIZE 1048576

#if FF_MAX_SS != FF_MIN_SS
#define FF_SSIZE( fsptr ) ((fsptr)->ssize)
#else
#define FF_SSIZE( fsptr ) 512
#endif

/* Print an error message for an error returned from the FAT driver */
static void fat_perror(char *custom_message, FRESULT result) {
	char *error_message;
	switch (result) {
		case FR_OK:
			error_message = "No error"; /* Not an error. Obviously. */
			break;
		case FR_DISK_ERR:
			error_message = "Low-level disk error";
			break;
		case FR_INT_ERR:
			error_message = "Internal error";
			break;
		case FR_NOT_READY:
			error_message = "Drive not ready";
			break;
		case FR_NO_FILE:
			error_message = "File not found";
			break;
		case FR_NO_PATH:
			error_message = "Path not found";
			break;
		case FR_INVALID_NAME:
			error_message = "File / directory name is invalid";
			break;
		case FR_DENIED:
			error_message = "Access denied";
			break;
		case FR_EXIST:
			error_message = "File / directory already exists";
			break;
		case FR_INVALID_OBJECT:
			error_message = "Invalid object";
			break;
		case FR_WRITE_PROTECTED:
			error_message = "Drive is write-protected";
			break;
		case FR_INVALID_DRIVE:
			error_message = "Invalid drive number";
			break;
		case FR_NOT_ENABLED:
			error_message = "Work area not initialised";
			break;
		case FR_NO_FILESYSTEM:
			error_message = "No FAT filesystem found";
			break;
		case FR_MKFS_ABORTED:
			error_message = "Disk is unsuitable for formatting";
			break;
		case FR_TIMEOUT:
			error_message = "Timeout";
			break;
		case FR_LOCKED:
			error_message = "File locked";
			break;
		case FR_NOT_ENOUGH_CORE:
			error_message = "Not enough memory";
			break;
		case FR_TOO_MANY_OPEN_FILES:
			error_message = "Too many open files";
			break;
		case FR_INVALID_PARAMETER:
			error_message = "Invalid parameter";
			break;
		default:
			error_message = "Unknown error code";
	}
	printf("%s: %s\n", custom_message, error_message);
}

static char *fat_type(BYTE fs_type) {
	switch (fs_type) {
		case FS_FAT12:
			return "FAT12";
		case FS_FAT16:
			return "FAT16";
		case FS_FAT32:
			return "FAT32";
		case FS_EXFAT:
			return "exFAT";
		default:
			return "unknown";
	}
}

/* compatibility wrapper for newer FatFs */
static FRESULT f_mkfs_compat(
        BYTE drv,                       /* Logical drive number */
        BYTE partition,         /* Partitioning rule 0:FDISK, 1:SFD */
        WORD allocsize,         /* Allocation unit size [bytes] */
        char *volume_label,
        BYTE fmt
)
{
	FRESULT result;
	BYTE work[FF_MAX_SS];	/* Working buffer */
	const char *path = 0 == drv ? DRV_0 : DRV_1; /* Logical drive number */
	// "format should generate two FATs (required by ESXDOS)" see 8ee674b
	MKFS_PARM opt = { .n_fat = 2, .au_size = allocsize }; /* Format options */
	// NOTE: ff.c has to be patched to change "FAT Signature" in VBR
	// "Use 'FAT12'/'FAT16' as the type descriptor,
	//     not just 'FAT' - ESXDOS checks it to distinguish from FAT32"
	// see a9af42a

	// "allow specifying a volume name on format/create" see 1b470de
	// NOTE: this is "Partition Volume Label"
	// "Software changing the directory volume label in the file
	//   system should also update this entry, but not all software does."
	memset(opt.label, ' ', 11);
	if (volume_label) {
		for (int i=0; i<11 && volume_label[i]; i++) {
			opt.label[i] = volume_label[i];
		}
	}
	// Newer f_mkfs has different params and no longer allows direct
	// FAT type choice. The only option remaining is the ability to
	// force FAT32 (provided volume is big enough)
	// thus, we must re-map FS_FATxx to FM_FATxx
	switch (fmt) {
		case FS_FAT32:
			opt.fmt = FM_FAT32;
			break;
		case FS_FAT12:
		case FS_FAT16:
			opt.fmt = FM_FAT;
			break;
		default:
			opt.fmt = FM_FAT|FM_FAT32;
			break;
	}
	// not used, but for the sake of completeness...
	if (1 == partition) {
		opt.fmt |= FM_SFD;
	}

	result = f_mkfs(path, &opt, work, sizeof(work));
	// once we have filesystem ready, set the volume label
	if (FR_OK == result && volume_label) {
		// When the string has a drive prefix, the volume label
		// will be set to the volume specified by the drive prefix.
		// If drive number is not specified, the volume label will
		// be set to the default drive.
		*work = '\0';
		strcpy(work, path); // 0: or 1:
		strcat(work, volume_label);
		result = f_setlabel(work);
		if (FR_OK != result) {
			fat_perror("Cannot set volume label", result);
		}
		// there is no reason for volume label creation to fail
		// but if it does, we ignore that
		return FR_OK;
	}
	return result;
}

/* return the number of total sectors and free sectors */
static FRESULT f_du(BYTE drv, size_t *total_sectors, size_t *free_sectors, BYTE *type) {
	const char *path = drv == 0 ? DRV_0 : DRV_1;
	FRESULT result;
	DWORD nclst;
	FATFS *fs;

	result = f_getfree(path, &nclst, &fs);
	if (result == FR_OK) {
		*total_sectors = (size_t)(fs->n_fatent - 2) * fs->csize;
		*free_sectors = (size_t)nclst * fs->csize;
		if (NULL != type) {
			*type = fs->fs_type;
		}
	}
	return result;
}

static unsigned long parse_volume_size(const char *const arg) {
	double unconverted_size;
	unsigned long sector_count;
	char *unit;

	unconverted_size = strtod(arg, &unit);

	if (*unit == 'G' || *unit == 'g') {
		sector_count = (unsigned long) (unconverted_size * (1<<30) / 512);
	} else if (*unit == 'M' || *unit == 'm') {
		sector_count = (unsigned long) (unconverted_size * (1<<20) / 512);
	} else if (*unit == 'K' || *unit == 'k') {
		sector_count = (unsigned long) (unconverted_size * (1<<10) / 512);
	} else if (*unit == 'B' || *unit == 'b' || *unit == 0) {
		sector_count = (unsigned long) (unconverted_size / 512);
	} else {
		printf("Unrecognised size unit specifier: %c\n", *unit);
		sector_count = 0;
	}
	return sector_count;
}

static void printsize(size_t size, char unit) {
	double value;

	if (unit == 0) { // no unit given, try to find it
		if (size > 1024*1024*1024) {
			unit = 'G';
		} else if (size > 1024*1024) {
			unit = 'M';
		} else if (size > 1024) {
			unit = 'K';
		} else {
			unit = 'B';
		}
	}
	switch (unit) {
		case 'G':
		case 'g':
			value = size / 1024.0 / 1024.0 / 1024.0;
			break;
		case 'M':
		case 'm':
			value = size / 1024.0 / 1024.0;
			break;
		case 'K':
		case 'k':
			value = size / 1024.0;
			break;
		default:
			//fpritnf(stderr, "WARNING: unsupported size unit '%c'\n", unit);
		case 'B':
		case 'b':
			value = size;
			unit = 'b';
			break;
	}

	if (unit == 'b' || unit == 'B') {
		printf("%zu %c", size, unit);
	} else {
		printf("%.02lf %c", value, unit);
	}
}

static void volume_stat(BYTE drv) {
	size_t total, free;
	BYTE fmt;

	f_du(drv, &total, &free, &fmt);
	printf("Total: %zu Free: %zu Type: %s\n", total * FF_SSIZE( fs ), free * FF_SSIZE( fs ), fat_type(fmt));
}

/* Open the file at pathname as an HDF or raw disk image, populating the passed
volume container and opening it as disk 0 for the FAT driver */
static int open_image(char *pathname, volume_container *vol, FATFS *fatfs, int writeable) {
	int res;
	
	if (image_file_is_hdf(pathname)) {
		/* HDF image file found */;
		res = hdf_image_open(vol, pathname, writeable);
	} else {
		/* Raw image file found */
		res = raw_image_open(vol, pathname, writeable);
	}
	if (res) return -1;
	
	disk_map(0, vol);
	
	if (fatfs != NULL) {
		if (f_mount(fatfs, DRV_0, 0) != FR_OK) {
			printf("mount failed\n");
			return -1;
		}
	}
	
	return 0;
}

static int filename_is_hdf(char *filename) {
	size_t len;
	
	len = strlen(filename);
	return (
		(filename[len-3] == 'h' || filename[len-3] == 'H')
		&& (filename[len-2] == 'd' || filename[len-2] == 'D')
		&& (filename[len-1] == 'f' || filename[len-1] == 'F')
	);
}

static int fat_path_is_dir(TCHAR *filename) {
	/* Test whether the given filename is a directory in the FAT filesystem. */
	/* Do this the quick-and-dirty way, by f_opendir-ing and checking for errors */
	FATDIR dir;
	FRESULT result;
	
	result = f_opendir(&dir, filename);
	if (result == FR_OK) {
		return 1;
	} else if (result == FR_NO_PATH) {
		return 0;
	} else {
		fat_perror("Error opening file", result);
		return -1;
	}
}

static char *concat_filename(char *path, char *filename) {
	char *out;
	size_t path_len, filename_len;
	
	path_len = strlen(path);
	filename_len = strlen(filename);
	
	out = malloc(path_len + 1 + filename_len + 1);
	if (!out) return NULL;
	strcpy(out, path);
	strcpy(out + path_len, "/");
	strcpy(out + path_len + 1, filename);
	strcpy(out + path_len + 1 + filename_len, "\0");
	
	return out;
}

static void strip_trailing_slash(char *path) {
	if (*path == '\0') return;
	while (*path != '\0') path++;
	path--;
	if (*path == '\\' || *path == '/') *path = '\0';
}

static int is_directory(char *path) {
	struct stat fileinfo;
	
	if (stat(path, &fileinfo) != 0) {
		return 0;
	}
	return (fileinfo.st_mode & S_IFDIR);
}

static int cmd_clone(int argc, char *argv[]) {
	char *source_filename;
	char *destination_filename;
	volume_container source_vol, destination_vol;
	static char buffer[CLONE_BUFFER_SIZE];
	size_t total_size, transfer_size;
	off_t position;
	
	if (argc >= 3) {
		source_filename = argv[2];
	} else {
		printf("No source image filename supplied\n");
		return -1;
	}
	
	if (argc >= 4) {
		destination_filename = argv[3];
	} else {
		printf("No destination image filename supplied\n");
		return -1;
	}
	
	if (open_image(source_filename, &source_vol, NULL, 0) == -1) {
		return -1;
	}
	
	if (filename_is_hdf(destination_filename)) {
		if (hdf_image_create(&destination_vol, destination_filename, source_vol.sector_count) == -1) {
			source_vol.close(&source_vol);
			return -1;
		}
	} else {
		if (raw_image_create(&destination_vol, destination_filename, source_vol.sector_count) == -1) {
			source_vol.close(&source_vol);
			return -1;
		}
	}
	
	position = 0;
	total_size = (size_t)source_vol.bytes_per_sector * source_vol.sector_count;
	
	while (position < total_size) {
		transfer_size = total_size - position;
		if (transfer_size > CLONE_BUFFER_SIZE) transfer_size = CLONE_BUFFER_SIZE;
		if (source_vol.read(&source_vol, position, buffer, transfer_size) < 0) {
			source_vol.close(&source_vol);
			destination_vol.close(&destination_vol);
			return -1;
		}
		if (destination_vol.write(&destination_vol, position, buffer, transfer_size) < 0) {
			source_vol.close(&source_vol);
			destination_vol.close(&destination_vol);
			return -1;
		}
		position += transfer_size;
	}
	
	source_vol.close(&source_vol);
	destination_vol.close(&destination_vol);
	return 0;
}

static FILE *open_file_or_stdout(char *filename, char *mode) {
	return 0 == strcmp("-", filename)
			? stdout : fopen(filename, mode);
}

/* here source_file must point to a file (not directory, no wildcards)
   and dest_filename must be a full path to a file, too. All directories
   must exist */
static int get_single_file(char *source_filename, char *dest_filename) {
	int rc = -1;
	int write_error = 0;
	FRESULT result;
	FIL fp;
	FILE *output_stream;
	UINT bytes_read;
	char buffer[BUFFER_SIZE];

	// if (VERBOSE) printf("copy %s -> %s\n", source_filename, dest_filename);
	if (FR_OK != (result = f_open(&fp, source_filename, FA_READ))) {
		// do nothing, FatFs error handler at the end
	} else if (!(output_stream = open_file_or_stdout(dest_filename, "wb"))) {
		fprintf(stderr, "Cannot open '%s' for writing: %s\n", dest_filename, strerror(errno));
		f_close(&fp);
	} else {
		do {
			if (FR_OK != (result = f_read(&fp, buffer, BUFFER_SIZE, &bytes_read))) {
				break;
			}
			if (bytes_read > 0) {
				if (fwrite(buffer, 1, bytes_read, output_stream) != bytes_read) {
					write_error = 1;
					break;
				}
			}
		} while (BUFFER_SIZE==bytes_read);

		if (stdout != output_stream) {
			if (fclose(output_stream) != 0) write_error = 1;
		} else if (fflush(stdout) != 0) {
			write_error = 1;
		}
		f_close(&fp);
		if (write_error) {
			fprintf(stderr, "Error writing '%s'\n", dest_filename);
		} else {
			rc = 0;
		}
	}

	if (FR_OK != result) { // report FatFs errors, if any
		fat_perror("Cannot read file", result);
		rc = -1;
	}

	return rc;
}

static int get_file(char *, char *);

#if FF_USE_FIND
static int get_from_pattern(char *source_pattern, char *dest_filename) {
	FATDIR dp;
	FILINFO fno;
	FRESULT	fr;
	char *pattern, *dir, *src;
	int rc = 0;

	// it may be better to use basename() and dirname() but those
	// require a copy of source_pattern each...
	// instead we just modify source_pattern in place
	if ((pattern = strrchr(source_pattern, '/'))) {
		dir = source_pattern;
		// terminate dir on the last '/' and move pattern one character
		*pattern++ = '\0';
	} else { // no slash, assume pattern only in the root dir
		// if FF_FS_RPATH==0 (our config), "" means "root", dots are not valid
		dir = ""; // also avoid double slashes after concat_filename(...)
		pattern = source_pattern;
	}

	fr = f_findfirst(&dp, &fno, dir, pattern);
	while (FR_OK == fr && fno.fname[0]) {
		src = concat_filename(dir, fno.fname);
		rc |= get_file(src, dest_filename);
		free(src);

		fr = f_findnext(&dp, &fno);
	}
	f_closedir(&dp);

	if (FR_OK != fr) {
		fat_perror("Error reading directory", fr);
		rc = -1;
	}

	return rc;
}
#endif // FF_USE_FIND

static int get_from_directory(char *source_dir, char *dest_filename) {
	FATDIR dp;
	FILINFO fno;
	FRESULT	fr;
	char *tdir, *src, *dst, *tmp;
	int rc = 0;

	//if (VERBOSE) printf("copy dir %s to %s\n", source_dir, dest_filename);
	// make the target directory first
	tdir = concat_filename(dest_filename, basename(tmp=strdup(source_dir)));
	free(tmp);
	if (0 != mkdir(tdir, 0700)) {
		if (EEXIST != errno || !is_directory(tdir)) {
			fprintf(stderr, "Cannot create directory '%s': %s\n", tdir, strerror(errno));
			free(tdir);
			return -1;
		}
	}

	fr = f_opendir(&dp, source_dir);
	while (FR_OK == fr) {
		fr = f_readdir(&dp, &fno);
		if (FR_OK != fr || !fno.fname[0]) break;
		src = concat_filename(source_dir, fno.fname);
		dst = concat_filename(tdir, fno.fname);
		if (AM_DIR & fno.fattrib) {
			rc |= get_file(src, tdir);
		} else {
			rc |= get_single_file(src, dst);
		}
		free(dst);
		free(src);
	}
	f_closedir(&dp);
	free(tdir);

	if (FR_OK != fr) {
		fat_perror("Error reading directory", fr);
		rc = -1;
	}

	return rc;
}

static int get_file(char *source_filename, char *dest_filename) {
	char *src, *dst, *tmp;
	int rc = 0;

	if (strpbrk(source_filename, "*?")) { // wildcard
#if FF_USE_FIND
		rc = get_from_pattern(source_filename, dest_filename);
#else
		printf("ERROR: FatFs compiled without FF_USE_FIND\n");
		rc = -1;
#endif
	} else if (fat_path_is_dir(source_filename)) {
		rc = get_from_directory(source_filename, dest_filename);
	} else if (is_directory(dest_filename)) {
		dst = concat_filename(dest_filename, basename(tmp=strdup(source_filename)));
		free(tmp);
		rc = get_single_file(source_filename, dst);
		free(dst);
	} else {
		rc = get_single_file(source_filename, dest_filename);
	}
	return rc;
}

static int cmd_get(int argc, char *argv[]) {
	char *image_filename;
	char *dest_filename;
	int files_idx;
	int files_count;
	int i;
	int rc = 0;
	
	volume_container vol;
	FATFS fatfs;
	FRESULT result;
	
	if (argc >= 3) {
		image_filename = argv[2];
	} else {
		printf("No image filename supplied\n");
		return -1;
	}

	if (argc < 4) {
		printf("No source filename supplied\n");
		return -1;
	}
	
	files_idx = 3;
	if (argc == 4) { // single input file, output to stdout
		dest_filename = "-";
		files_count = 1;
	} else if (argc > 4) {
		dest_filename = argv[argc-1];
		files_count = argc - 4;
		if (files_count > 1 && !is_directory(dest_filename)) {
			printf("Destination must be a directory\n");
			return -1;
		}
		strip_trailing_slash(dest_filename);
	} else {
		printf("Should not happen\n");
		return -1;
	}
	
	if (open_image(image_filename, &vol, &fatfs, 0) == -1) {
		return -1;
	}
	
	for (i=0; i<files_count; i++) {
		int pos = files_idx + i;
		if (0 != get_file(argv[pos], dest_filename)) {
			// if there was a problem reading/writing -- abort
			printf("Cannot get file '%s'\n", argv[pos]);
			rc = -1;
			break;
		}
	}

	return rc;
}

static FILE *open_file_or_stdin(char *filename, char *mode) {
	return 0 == strcmp("-", filename)
			? stdin : fopen(filename, mode);
}

static int put_file(char *source_filename, char *dest_filename) {
	FILE *input_file;
	FIL output_file;
	FRESULT result;
	int rc = 0;
	
	char buffer[BUFFER_SIZE];
	size_t bytes_read;
	UINT bytes_written;
	
	DIR *dir;
	struct dirent *dir_entry;
	
	char *source_child_filename;
	char *dest_child_filename;
	
	if (is_directory(source_filename)) {
		if (!fat_path_is_dir(dest_filename)) {
			result = f_mkdir(dest_filename);
			if (result != FR_OK) {
				fat_perror("Directory creation failed", result);
				return -1;
			}
		}
		dir = opendir(source_filename);
		if (!dir) {
			perror("Error opening directory");
			return -1;
		}
		
		while ((dir_entry = readdir(dir))) {
			if ( strcmp(dir_entry->d_name, ".") != 0 && strcmp(dir_entry->d_name, "..") != 0 ) {
				source_child_filename = concat_filename(source_filename, dir_entry->d_name);
				dest_child_filename = concat_filename(dest_filename, dir_entry->d_name);
				if (put_file(source_child_filename, dest_child_filename) == -1) rc = -1;
				free(source_child_filename);
				free(dest_child_filename);
			}
		}
		
		closedir(dir);
		if (rc != 0) return rc;
	} else {
		input_file = open_file_or_stdin(source_filename, "rb");
		if (!input_file) {
			perror("Could not open file for reading");
			return -1;
		}
		
		result = f_open(&output_file, dest_filename, FA_WRITE | FA_CREATE_ALWAYS);
		if (result != FR_OK) {
			fat_perror("Error opening file for writing", result);
			return -1;
		}
		
		do {
			bytes_read = fread(buffer, 1, BUFFER_SIZE, input_file);
			if (ferror(input_file)) {
				perror("Error reading file");
				return -1;
			}
			if (bytes_read != 0) {
				result = f_write(&output_file, buffer, bytes_read, &bytes_written);
				if (result != FR_OK) {
					fat_perror("Error writing file", result);
					f_close(&output_file);
					return -1;
				}
				if (bytes_written != bytes_read) {
					/* a partial file must not look like a success */
					printf("Error writing file: Disk full\n");
					f_close(&output_file);
					f_unlink(dest_filename);
					return -1;
				}
			}
		} while (bytes_read == BUFFER_SIZE);
		
		if (stdin != input_file) {
			fclose(input_file);
		}
		result = f_close(&output_file);
		if (result != FR_OK) {
			fat_perror("Error writing file", result);
			return -1;
		}
	}

	return 0;
}

static int cmd_put(int argc, char *argv[]) {
	char *image_filename;
	char *source_filename;
	char *dest_path;
	char *dest_filename;
	
	volume_container vol;
	FATFS fatfs;
	int copying_to_dir;
	int i;
	int rc = 0;
	
	if (argc < 4) {
		printf("Usage: hdfmonkey put <image_file> <source_files> <destination_file_or_dir>\n");
		return -1;
	}
	
	image_filename = argv[2];
	if (open_image(image_filename, &vol, &fatfs, 1) == -1) {
		return -1;
	}
	
	dest_path = argv[argc-1];
	strip_trailing_slash(dest_path);
	copying_to_dir = fat_path_is_dir(dest_path);
	if (copying_to_dir == -1) {
		return -1;
	}
	
	if (!copying_to_dir) {
		if (argc > 5) {
			printf("Destination must be an existing directory when copying multiple files\n");
			return -1;
		}
		
		source_filename = argv[3];
		
		if ( put_file(source_filename, dest_path) == -1 ) {
			return -1;
		}
		
		return 0;
	} else {
		for (i = 3; i < (argc-1); i++) {
			dest_filename = concat_filename(dest_path, basename(argv[i]));
			if (!dest_filename) {
				printf("Out of memory\n");
				return -1;
			}
			if (put_file(argv[i], dest_filename) == -1) rc = -1;
			free(dest_filename);
		}
		return rc;
	}
}

static int cmd_ls(int argc, char *argv[]) {
	char *image_filename;
	volume_container vol_container;
	
	FATFS fatfs;
	FATDIR dir;
	FRESULT result;
	FILINFO file_info;
	
	TCHAR* dirname;
	
	if (argc < 3) {
		printf("No image filename supplied\n");
		return -1;
	}
	
	image_filename = argv[2];
	
	if (open_image(image_filename, &vol_container, &fatfs, 0) == -1) {
		return -1;
	}
	
	if (argc > 3) {
		/* explicit path specified */
		dirname = argv[3];
	} else {
		/* no path specified - use root */
		dirname = "";
	}
	
	if ((result = f_opendir(&dir, dirname)) != FR_OK) {
		fat_perror("Error opening dir", result);
		return -1;
	}
	
	while(1) {
		if ((result = f_readdir(&dir, &file_info)) != FR_OK) {
			fat_perror("Error reading dir", result);
			return -1;
		}
		if (file_info.fname[0] == '\0') break;
		
		/* indicate whether file is a dir or a regular file */
		if (file_info.fattrib & AM_DIR) {
			printf("[DIR]\t");
		} else {
			printf("%lu\t", (unsigned long) file_info.fsize);
		}
		
		/* TL;DR: just use fname unless you really need 8.3 name */
		printf("%s\n", file_info.fname);
/* http://elm-chan.org/fsw/ff/doc/readdir.html
"When LFN is enabled, a member altname[] is defined in the file
information structure to store the short file name of the object. If the
long file name is not accessible due to any reason listed below, short
file name is stored to the fname[] and the altname[] has a null string."
*/
	}
	
	vol_container.close(&vol_container);

	return 0;
}

static int cmd_format(int argc, char *argv[]) {
	char *image_filename;
	char *volumelabel = NULL;
	volume_container vol;
	FATFS fatfs;
	FRESULT result;
	BYTE fmt = 0;
	int i;
	
	int arg_num = 0;
	for (i = 2; i < argc; i++) {
		if (strcmp(argv[i], "--fat12") == 0) {
			fmt = FS_FAT12;
		} else if (strcmp(argv[i], "--fat16") == 0) {
			fmt = FS_FAT16;
		} else if (strcmp(argv[i], "--fat32") == 0) {
			fmt = FS_FAT32;
		} else {
			switch (arg_num) {
				case 0:
					image_filename = argv[i];
					arg_num++;
					break;
				case 1:
					volumelabel = argv[i];
					arg_num++;
					break;
				default:
					arg_num++;
			}
		}
	}

	if (arg_num < 1 || arg_num > 2) {
		printf("Usage: hdfmonkey format [--fat12|--fat16|--fat32] <imagefile> [volumelabel]\n");
		return -1;
	}

	if (open_image(image_filename, &vol, &fatfs, 1) == -1) {
		return -1;
	}
	
	result = f_mkfs_compat(0, 0, 0, volumelabel, fmt);
	if (result != FR_OK) {
		fat_perror("Formatting failed", result);
		return -1;
	}
	
	return 0;
}

static int cmd_create(int argc, char *argv[]) {
	char *image_filename;
	volume_container vol;
	FATFS fatfs;
	FRESULT result;
	unsigned long sector_count;
	char *volumelabel = NULL;
	BYTE fmt = 0;
	int verbose = 0;
	size_t total, free;
	int i;

	int arg_num = 0;
	for (i = 2; i < argc; i++) {
		if (strcmp(argv[i], "--fat12") == 0) {
			fmt = FS_FAT12;
		} else if (strcmp(argv[i], "--fat16") == 0) {
			fmt = FS_FAT16;
		} else if (strcmp(argv[i], "--fat32") == 0) {
			fmt = FS_FAT32;
		} else if (strcmp(argv[i], "--verbose") == 0) {
			verbose = 1;
		} else {
			switch (arg_num) {
				case 0:
					image_filename = argv[i];
					arg_num++;
					break;
				case 1:
					sector_count = parse_volume_size(argv[i]);
					arg_num++;
					break;
				case 2:
					volumelabel = argv[i];
					arg_num++;
					break;
				default:
					arg_num++;
			}
		}
	}

	if (arg_num < 2 || arg_num > 3) {
		printf("Usage: hdfmonkey create [--fat12|--fat16|--fat32] [--verbose] <imagefile> <size> [volumelabel]\n");
		printf(" NOTE: --fat12 and --fat16 no longer work with new FatFs!\n");
		return -1;
	}

	if (sector_count == 0) {
		// parse_volume_size has reported all errors
		return -1;
	}

	if (filename_is_hdf(image_filename)) {
		if (hdf_image_create(&vol, image_filename, sector_count) == -1) {
			return -1;
		}
	} else {
		if (raw_image_create(&vol, image_filename, sector_count) == -1) {
			return -1;
		}
	}
	
	disk_map(0, &vol);
	
	if (f_mount(&fatfs, DRV_0, 0) != FR_OK) {
		printf("mount failed\n");
		vol.close(&vol);
		return -1;
	}
	
	result = f_mkfs_compat(0, 0, 0, volumelabel, fmt);
	if (result != FR_OK) {
		fat_perror("Formatting failed", result);
		vol.close(&vol);
		return -1;
	}

	if (verbose) {
		volume_stat(0);
	}
	
	vol.close(&vol);
	return 0;
}

static FRESULT makepath(char *dir_name) {
	FRESULT result;
	char *sep = dir_name;

	// NOTE: we are modifying argv[N] here!!! strdup to be safe?
	while (NULL != (sep = strchr(sep+1, '/'))) {
		if ('/' == *(sep - 1)) {
			sep++;
			continue;
		}
		*sep = '\0';
		result = f_mkdir(dir_name);
		*sep = '/';
		// TODO: if it exists but not a dir? check f_stat
		if (FR_OK != result && FR_EXIST != result) {
			return result;
		}
	}
	result = f_mkdir(dir_name);
	if (FR_EXIST == result) {
		result = FR_OK;
	}

	return result;
}

static int makedir(char *dir_name, int make_path) {
	FRESULT result;
	int rc = 0;

	if (0 == strlen(dir_name)) {
		printf("Empty directory name skipped\n");
	} else {
		if (make_path) {
			result = makepath(dir_name);
		} else {
			result = f_mkdir(dir_name);
		}
		if (FR_OK != result) {
			printf("ERROR: Cannot mkdir '%s'\n", dir_name);
			fat_perror("Directory creation failed", result);
			rc = -1;
		}
	}

	return rc;
}

static int cmd_mkdir(int argc, char *argv[]) {
	char *image_filename;
	char *dir_name;
	int i, arg_num = 0;
	int verbose = 0;
	int make_path = 0;
	volume_container vol;
	FATFS fatfs;
	FRESULT result;
	int rc = 0;
	
	for (i = 2; arg_num < 2 && i < argc; i++) {
		if (strcmp(argv[i], "--parents") == 0) {
			make_path = 1;
		} else if (strcmp(argv[i], "-p") == 0) {
			make_path = 1;
		} else if (strcmp(argv[i], "--verbose") == 0) {
			verbose = 1;
		} else {
			switch (arg_num) {
				case 0:
					image_filename = argv[i];
					arg_num++;
					break;
				case 1:
					dir_name = argv[i];
					arg_num++;
					break;
			}
		}
	}

	if (arg_num < 2) {
		printf("Usage: hdfmonkey mkdir [--parents|-p] <imagefile> <dir> [<dir2> [... <dirN>]]\n");
		return -1;
	}

	if (open_image(image_filename, &vol, &fatfs, 1) == -1) {
		return -1;
	}

	if (verbose) printf("%s\n", dir_name);
	rc |= makedir(dir_name, make_path);
	
	for ( ; i < argc; i++ ) { // continue processing remaining arguments
		dir_name = argv[i];

		if (verbose) printf("%s\n", dir_name);
		rc |= makedir(dir_name, make_path);
	}

	vol.close(&vol);
	return rc;
}

static int cmd_rm(int argc, char *argv[]) {
	char *image_filename;
	char *filename;
	volume_container vol;
	FATFS fatfs;
	FRESULT result;
	int i = 2;
	
	if (argc < 3) {
		printf("No image filename supplied\n");
		return -1;
	}
	image_filename = argv[i++];
	
	if (i == argc) {
		printf("No filename supplied\n");
		return -1;
	}
	
	if (open_image(image_filename, &vol, &fatfs, 1) == -1) {
		return -1;
	}
	
	while (i < argc) {
		filename = argv[i++];
		result = f_unlink(filename);
		if (result != FR_OK) {
			fat_perror("Deletion failed", result);
			return -1;
		}
	}
	
	return 0;
}

/* Recursively copy directory contents file-by-file from one filesystem to another.
The destination directory must exist. */
static int copy_dir(TCHAR *source_dirname, TCHAR *destination_dirname) {
	FIL source_file, destination_file;
	FRESULT result;
	char buffer[BUFFER_SIZE];
	UINT bytes_read, bytes_written;
	FATDIR source_dir;
	FILINFO file_info;
	TCHAR *source_filename, *destination_filename;

	result = f_opendir(&source_dir, source_dirname);
	if (result != FR_OK) {
		fat_perror("Error opening source directory", result);
		return -1;
	}

	while(1) {
		if ((result = f_readdir(&source_dir, &file_info)) != FR_OK) {
			fat_perror("Error reading dir", result);
			return -1;
		}
		if (file_info.fname[0] == '\0') break;
		
		/* TL;DR: just use fname unless you really need 8.3 name */
		source_filename = concat_filename(source_dirname, file_info.fname);
		destination_filename = concat_filename(destination_dirname, file_info.fname);
/* http://elm-chan.org/fsw/ff/doc/readdir.html
"When LFN is enabled, a member altname[] is defined in the file
information structure to store the short file name of the object. If the
long file name is not accessible due to any reason listed below, short
file name is stored to the fname[] and the altname[] has a null string."
*/

		if (file_info.fattrib & AM_DIR) {
			/* File is a directory - copy recursively */
			result = f_mkdir(destination_filename);
			if (result != FR_OK) {
				fat_perror("Error creating directory", result);
				free(source_filename);
				free(destination_filename);
				return -1;
			}
			if (copy_dir(source_filename, destination_filename) != 0) {
				free(source_filename);
				free(destination_filename);
				return -1;
			}
		} else {
			/* File is a regular file */
			result = f_open(&source_file, source_filename, FA_READ);
			if (result != FR_OK) {
				printf("error on file %s\n", source_filename);
				fat_perror("Error opening source file", result);
				free(source_filename);
				free(destination_filename);
				return -1;
			}

			result = f_open(&destination_file, destination_filename, FA_WRITE | FA_CREATE_ALWAYS);
			if (result != FR_OK) {
				fat_perror("Error opening destination file", result);
				free(source_filename);
				free(destination_filename);
				f_close(&source_file);
				return -1;
			}

			do {
				result = f_read(&source_file, buffer, BUFFER_SIZE, &bytes_read);
				if (result != FR_OK) {
					fat_perror("Error reading file", result);
					f_close(&source_file);
					f_close(&destination_file);
					free(source_filename);
					free(destination_filename);
					return -1;
				}
				result = f_write(&destination_file, buffer, bytes_read, &bytes_written);
				if (result != FR_OK) {
					fat_perror("Error writing file", result);
					f_close(&source_file);
					f_close(&destination_file);
					free(source_filename);
					free(destination_filename);
					return -1;
				}
			} while (bytes_read == BUFFER_SIZE);

			f_close(&source_file);
			f_close(&destination_file);
		}

		free(source_filename);
		free(destination_filename);
	}

	return 0;
}

static int cmd_rebuild(int argc, char *argv[]) {
	char *source_filename;
	char *destination_filename;
	char *volumelabel = NULL;
	unsigned long sector_count = 1; // "undefined", volume cannot be 1 sector long
	volume_container source_vol, destination_vol;
	FATFS source_fatfs, destination_fatfs;
	size_t total, free, used; // used to estimate src volume usage
	DWORD nclst;	// used to force-mount src via f_getfree call
	FATFS *fs;	// used to force-mount src via f_getfree call
	FRESULT result;

	BYTE fmt = 0;
	int verbose = 0;
	int i;

	int arg_num = 0;
	for (i = 2; i < argc; i++) {
		if (strcmp(argv[i], "--fat12") == 0) {
			fmt = FS_FAT12;
		} else if (strcmp(argv[i], "--fat16") == 0) {
			fmt = FS_FAT16;
		} else if (strcmp(argv[i], "--fat32") == 0) {
			fmt = FS_FAT32;
		} else if (strcmp(argv[i], "--keep") == 0) {
			fmt = FS_SAME;
		} else if (strcmp(argv[i], "--verbose") == 0) {
			verbose = 1;
		} else {
			switch (arg_num) {
				case 0:
					source_filename = argv[i];
					arg_num++;
					break;
				case 1:
					destination_filename = argv[i];
					arg_num++;
					break;
				case 2:
					volumelabel = argv[i];
					arg_num++;
					break;
				case 3:
					sector_count = parse_volume_size(argv[i]);
					// intentionally not incrementing arg_num
					break;
				default:
					arg_num++;
			}
		}
	}

	if (sector_count == 0) {
		// wrong size requested, errors reported by parse_volume_size
		return -1;
	}

	if (arg_num < 2 || arg_num > 3) {
		printf("Usage: hdfmonkey rebuild [--fat12|--fat16|--fat32|--keep] [--verbose] <source-image-file> <destination-image-file> [volumelabel [new-size]]\n");
		return -1;
	}

	if (open_image(source_filename, &source_vol, &source_fatfs, 0) == -1) {
		return -1;
	}

	if (sector_count == 1) { // not defined, size is the same as source's
		sector_count = source_vol.sector_count;
	} else { // quick check if requested size is reasonable
		if (f_du(0, &total, &free, NULL)!=FR_OK) {
			source_vol.close(&source_vol);
			fat_perror("Error gettig disk space usage", result);
			return -1;
		}
		// N_SEC_TRACK is used as "estimated partition offset", see ff.c:f_mkfs
		// +2 is for f_du adjustements to account for the "Number of FAT entries
		// (number of clusters + 2)"
		used = total - free + N_SEC_TRACK + 2;
		// NOTE: this is not an accurate estimate, this is a basic fail-safe.
		// If destination volume will use different (larger) cluster size
		// there may NOT be enough free clusters! At least it warns user
		// in sutiations like "trying to copy 2G image to 512M image".
		if (sector_count < used) {
			source_vol.close(&source_vol);
			printf("ERROR: Not enough space on the new volume, needed at least %zu\n", used*512);
			return -1;
		}
	}

	if (filename_is_hdf(destination_filename)) {
		if (hdf_image_create(&destination_vol, destination_filename, sector_count) == -1) {
			source_vol.close(&source_vol);
			return -1;
		}
	} else {
		if (raw_image_create(&destination_vol, destination_filename, sector_count) == -1) {
			source_vol.close(&source_vol);
			return -1;
		}
	}
	
	disk_map(1, &destination_vol);
	
	if (f_mount(&destination_fatfs, DRV_1, 0) != FR_OK) {
		printf("mount failed\n");
		source_vol.close(&source_vol);
		destination_vol.close(&destination_vol);
		return -1;
	}
	
	// use the same FAT type as source, if explicitly requested
	if (fmt == FS_SAME) {
		// force drive access to fill FATFS structure (we're lazy mounting)
		f_getfree(DRV_0, &nclst, &fs);
		fmt = fs->fs_type;
	}

	result = f_mkfs_compat(1, 0, 0, volumelabel, fmt);
	if (result != FR_OK) {
		fat_perror("Formatting failed", result);
		source_vol.close(&source_vol);
		destination_vol.close(&destination_vol);
		return -1;
	}

	copy_dir("0:", "1:");

	if (verbose) {
		volume_stat(1);
	}

	source_vol.close(&source_vol);
	destination_vol.close(&destination_vol);
	return 0;
}

static int cmd_free(int argc, char *argv[]) {
	char *image_filename;
	char unit; // b k m g or 0 (auto)
	volume_container vol_container;
	FATFS fatfs;
	FRESULT result;
	size_t total, free;
	BYTE fmt;

	if (argc < 3) {
		printf("Usage: hdfmonkey free <imagefile> [unit]\n");
		return -1;
	}

	image_filename = argv[2];
	unit = argc > 3 ? argv[3][0] : '\0';

	if (open_image(image_filename, &vol_container, &fatfs, 0) == -1) {
		return -1;
	}

	result = f_du(0, &total, &free, &fmt);

	vol_container.close(&vol_container);

	if (result == FR_OK) {
		printf("%s: ", image_filename);
		printsize(total * FF_SSIZE( &fatfs ), unit);
		printf(", free ");
		printsize(free * FF_SSIZE( &fatfs ), unit);
		printf(" type: %s\n", fat_type(fmt));
		return 0;
	} else {
		fat_perror("Unable to get free clusters count", result);
		return -1;
	}

}

static int cmd_help(int argc, char *argv[]) {
	if (argc < 3) {
		printf("hdfmonkey: utility for manipulating HDF disk images v" VERSION "\n");
#ifdef HDF_USE_WINAPI
		printf("           WinAPI enabled: creates sparse files\n");
#endif
#ifdef HDF_MINGW_WILDCARD
		printf("           wildcard expansion %s\n", _dowildcard ? "enabled" : "disabled");
#endif
		printf("           using FatFs revision %d\n\n", FF_DEFINED);
		printf("usage: hdfmonkey <command> [args]\n\n");
		printf("Type 'hdfmonkey help <command>' for help on a specific command.\n");
		printf("Available commands:\n");
		printf("\tclone\n\tcreate\n\tformat\n\tget\n\thelp\n\tls\n\tmkdir\n\tput\n\trebuild\n\trm\n");
	} else if (strcmp(argv[2], "clone") == 0) {
		printf("clone: Make a new image file from a disk or image, possibly in a different container format\n");
		printf("usage: hdfmonkey clone <oldimagefile> <newimagefile>\n");
	} else if (strcmp(argv[2], "create") == 0) {
		printf("create: Create a new FAT-formatted image file\n");
		printf("usage: hdfmonkey create [--fat12|--fat16|--fat32] [--verbose] <imagefile> <size> [volumelabel]\n");
		printf("Size is given in bytes (B), kilobytes (K), megabytes (M) or gigabytes (G) -\n");
		printf("e.g. 64M, 1.5G\n");
		printf("Neither --fat12 nor --fat16 are working with newer FatFs and kept for\n"
			"compatibility reasons only. Minimal image size:\n"
			"  FAT16 - 4250624 bytes, FAT32 - 34131456 bytes\n");
	} else if (strcmp(argv[2], "format") == 0) {
		printf("format: Formats the entire disk image as a FAT filesystem\n");
		printf("usage: hdfmonkey format [--fat12|--fat16|--fat32] <imagefile> [volumelabel]\n");
	} else if (strcmp(argv[2], "free") == 0) {
		printf("free: Gets the total size of the volume and the free space size\n");
		printf("usage: hdfmonkey free <imagefile> [b|K|M|G]\n");
	} else if (strcmp(argv[2], "get") == 0) {
		printf("get: Copy file(s) from the disk image to local storage\n");
		printf("usage: hdfmonkey get <imagefile> <source> <destination>\n");
		printf("Source can be a file name, directory or pattern\n");
		printf("Destination is either a file name or directory\n");
		printf("Will write the file to standard output if only one source file selected\nand no destination file is specified.\n");
#if defined(WIN32) || defined(WIN64)
		// The following taken verbatim from FatFs docs
		printf("There are some differences between FatFs and standard systems in matching:\n");
		printf("- \"*.*\" does not match any name without extension while it matches any\n  name with or without extension in standard systems.\n- The pattern terminated with a dot does not match any name while it matches\n  the name without extensiton in standard systems.\n");
#endif
	} else if (strcmp(argv[2], "help") == 0) {
		printf("help: Describe the usage of this program or its commands.\n");
		printf("usage: hdfmonkey help [command]\n");
	} else if (strcmp(argv[2], "ls") == 0) {
		printf("ls: Show a directory listing\n");
		printf("usage: hdfmonkey ls <imagefile> [path]\n");
		printf("Will list the root directory if no path is specified.\n");
	} else if (strcmp(argv[2], "mkdir") == 0) {
		printf("mkdir: Create a directory\n");
		printf("usage: hdfmonkey mkdir [--parents|-p] <imagefile> <dirname> [<dir2> [... <dirN>]]\n");
	} else if (strcmp(argv[2], "put") == 0) {
		printf("put: Copy local files to the disk image\n");
		printf("usage: hdfmonkey put <image-file> <source-files> <dest-file-or-dir>\n");
	} else if (strcmp(argv[2], "rebuild") == 0) {
		printf("rebuild: Copy contents of the source image file-by-file to a new disk image;\n\tensures that the resulting image is unfragmented;\n\ttarget image size can be adjusted;\n\t--keep selects the same FAT type (12/16/32) as source\n");
		printf("usage: hdfmonkey rebuild [--fat12|--fat16|--fat32|--keep] [--verbose] <source-image-file> <destination-image-file> [volumelabel [new-size]]\n");
	} else if (strcmp(argv[2], "rm") == 0) {
		printf("rm: Remove files or directories\n");
		printf("usage: hdfmonkey rm <imagefile> <filenames>\n");
		printf("Directories must be empty before they can be deleted.\n");
	} else {
		printf("Unknown command: '%s'\n", argv[2]);
	}
	return 0;
}

int main(int argc, char *argv[]) {
	if (argc < 2) {
		/* fall through to help prompt */
	} else if (strcmp(argv[1], "clone") == 0) {
		return cmd_clone(argc, argv);
	} else if (strcmp(argv[1], "create") == 0) {
		return cmd_create(argc, argv);
	} else if (strcmp(argv[1], "format") == 0) {
		return cmd_format(argc, argv);
	} else if (strcmp(argv[1], "free") == 0) {
		return cmd_free(argc, argv);
	} else if (strcmp(argv[1], "get") == 0) {
		return cmd_get(argc, argv);
	} else if (strcmp(argv[1], "help") == 0) {
		return cmd_help(argc, argv);
	} else if (strcmp(argv[1], "ls") == 0) {
		return cmd_ls(argc, argv);
	} else if (strcmp(argv[1], "mkdir") == 0) {
		return cmd_mkdir(argc, argv);
	} else if (strcmp(argv[1], "put") == 0) {
		return cmd_put(argc, argv);
	} else if (strcmp(argv[1], "rebuild") == 0) {
		return cmd_rebuild(argc, argv);
	} else if (strcmp(argv[1], "rm") == 0) {
		return cmd_rm(argc, argv);
	} else {
		printf("Unknown command: '%s'\n", argv[1]);
	}
	printf("Type 'hdfmonkey help' for usage. v" VERSION IDTAG);
	/* continue human readable string showing enabled optional features */
#ifdef HDF_MINGW_WILDCARD
	printf("%s", _dowildcard ? "+wildcard" : "");
#endif
	puts(""); // "The puts function appends the newline character to the output"
	return 0;
}
