/* Low-level disk operations required by the FAT driver                  */

#include <config.h>

#include "ff.h"			/* Obtains integer types */
#include "diskio.h"		/* Declarations of disk functions */

static volume_container *volume_containers[8];

/*-----------------------------------------------------------------------*/
/* Associate a volume_container structure with a drive number so that it */
/* can be addressed by the FAT driver                                    */
/*-----------------------------------------------------------------------*/

DSTATUS disk_map (
	BYTE drive_number,
	volume_container *vol
)
{
	volume_containers[drive_number] = vol;
	return 0; /* status = success */
}

/*-----------------------------------------------------------------------*/
/* Get Drive Status                                                      */
/*-----------------------------------------------------------------------*/

DSTATUS disk_status (
	BYTE pdrv		/* Physical drive nmuber to identify the drive */
)
{
	return 0; /* status = success */
}



/*-----------------------------------------------------------------------*/
/* Inidialize a Drive                                                    */
/*-----------------------------------------------------------------------*/

DSTATUS disk_initialize (
	BYTE pdrv				/* Physical drive nmuber to identify the drive */
)
{
	return 0; /* status = success */
}



/*-----------------------------------------------------------------------*/
/* Read Sector(s)                                                        */
/*-----------------------------------------------------------------------*/

DRESULT disk_read (
	BYTE pdrv,		/* Physical drive nmuber to identify the drive */
	BYTE *buff,		/* Data buffer to store read data */
	LBA_t sector,	/* Start sector in LBA */
	UINT count		/* Number of sectors to read */
)
{
	volume_container *vol;
	size_t size_requested;
	ssize_t result;

	vol = volume_containers[pdrv];
	size_requested = (size_t)count * vol->bytes_per_sector;

	result = vol->read(vol, (off_t)sector * vol->bytes_per_sector, (void *)buff,
		size_requested);

	if (result == size_requested) {
		return RES_OK;
	} else {
		return RES_PARERR;
	}
}



/*-----------------------------------------------------------------------*/
/* Write Sector(s)                                                       */
/*-----------------------------------------------------------------------*/

#if FF_FS_READONLY == 0

DRESULT disk_write (
	BYTE pdrv,			/* Physical drive nmuber to identify the drive */
	const BYTE *buff,	/* Data to be written */
	LBA_t sector,		/* Start sector in LBA */
	UINT count			/* Number of sectors to write */
)
{
	volume_container *vol;
	size_t size_requested;
	ssize_t result;

	vol = volume_containers[pdrv];
	size_requested = (size_t)count * vol->bytes_per_sector;

	result = vol->write(vol, (off_t)sector * vol->bytes_per_sector, (void *)buff,
		size_requested);

	if (result == size_requested) {
		return RES_OK;
	} else {
		return RES_PARERR;
	}
}

#endif


/*-----------------------------------------------------------------------*/
/* Miscellaneous Functions                                               */
/*-----------------------------------------------------------------------*/

DRESULT disk_ioctl (
	BYTE pdrv,		/* Physical drive nmuber (0..) */
	BYTE cmd,		/* Control code */
	void *buff		/* Buffer to send/receive control data */
)
{
	switch (cmd) {
		case CTRL_SYNC:
			/* syncing happens automatically on write */
			return RES_OK;
		case GET_SECTOR_SIZE:
			*((WORD *)buff) = volume_containers[pdrv]->bytes_per_sector;
			return RES_OK;
		case GET_SECTOR_COUNT:
			*((DWORD *)buff) = volume_containers[pdrv]->sector_count;
			return RES_OK;
		case GET_BLOCK_SIZE:
			*((DWORD *)buff) = 1;
			return RES_OK;
		default:
			return RES_PARERR;
	}
}

