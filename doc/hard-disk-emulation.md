# Hard Disk Emulation

## Overview

The PicoExpander emulates the **SVI-608M** hard disk expansion unit, allowing CP/M to access a 10 MB hard disk image served over Wi-Fi from the file server. This eliminates the need for the original SVI-608M hardware with its Seagate ST-212 hard disk and WD1002-SHD controller.

For detailed technical information about the original SVI-608M hardware, see [svi-328.dev/svi-608m](https://svi-328.dev/svi-608m).

## How It Works

The original SVI-608M uses a SASI bus interface mapped to I/O ports 40h–46h. The PicoExpander intercepts these port accesses and emulates the SASI protocol, translating disk read/write commands into network requests to the file server on your PC/Mac.

The emulated disk has the same geometry as the original Seagate ST-212: 306 cylinders, 4 heads, 32 sectors per track, with 256-byte sectors — totaling 10 MB of storage. The disk image is divided into four CP/M partitions:

| Partition | Size | Drive Letter |
|-----------|------|-------------|
| 1 | 2 MB | A: |
| 2 | 2 MB | B: |
| 3 | 2 MB | C: |
| 4 | ~3.1 MB | D: |

## Usage

### Booting from Hard Disk

1. Start the file server with a directory containing a hard disk image
2. Boot the SVI with the PicoExpander
3. Press **F3** in the PicoExpander menu to boot from the hard disk

### Creating a Hard Disk Image

To create a bootable hard disk image, you need the **T0T1.SYS** file from the CP/M 2.27 system disk for the SVI-608M. This file contains the boot sector and CP/M system tracks that are written to the first two tracks of the hard disk image. You can download it from [svi-328.dev](https://svi-328.dev/svi-608m/images/stitched_cpm_227_608m_system_40ss/T0T1.SYS).

Once you have T0T1.SYS, use the `hdd_sysgen.js` script to create the image:

```bash
node js/hdd_sysgen.js
```

### Server-Based Backing

The hard disk image is stored on your PC/Mac and accessed over Wi-Fi. All read and write operations are transparently forwarded between the SVI and the file server. Changes are persisted to the image file on the server.
