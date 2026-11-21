/*
 * Direct C API for the web (wasm) build.
 *
 * While xfel_run() (see xfel_main.c) drives the unchanged main() with a
 * command line string, this adapter keeps a persistent xfel context and
 * exposes every operation as an exported function, so frontends can call
 * xfel directly without string parsing or command lines:
 *
 *   xfel_api_open()        scan usb, open device, fel_init() once
 *   xfel_api_read32()      fel_chip_read32()
 *   xfel_api_read()        fel_read_progress() with progress callback
 *   xfel_api_spinor_*()    spinor.h
 *   ... (see the exported list below)
 *
 * The underlying WebUSB device stays opened and claimed across calls
 * (see libusb_webusb.c), so only the FEL version handshake of fel_init()
 * happens once per session instead of once per command. Binary buffers
 * are passed as pointers into the wasm heap, no MEMFS round trip.
 *
 * The command line path remains available for terminal-style frontends:
 * xfel_run("spinand splwrite ...") works alongside this API. Commands
 * without a direct binding here (xfel extra ...) can only be reached
 * through xfel_run().
 */

#include <fel.h>
#include <spinor.h>
#include <spinand.h>
#include <sha256.h>
#include <ecdsa256.h>
#include <misc.h>
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#define FEL_USB_VID		0x1f3a
#define FEL_USB_PID		0xefe8

static struct xfel_ctx_t g_ctx;
static int g_open = 0;

static int api_find_and_open(void)
{
	libusb_device ** list = NULL;
	libusb_context * context = NULL;
	int count, found = 0;

	memset(&g_ctx, 0, sizeof(g_ctx));
	if(libusb_init(&context) != 0)
		return 0;
	count = libusb_get_device_list(context, &list);
	for(int i = 0; i < count; i++)
	{
		struct libusb_device_descriptor desc;
		if(libusb_get_device_descriptor(list[i], &desc) != 0)
			continue;
		if((desc.idVendor == FEL_USB_VID) && (desc.idProduct == FEL_USB_PID))
		{
			if(libusb_open(list[i], &g_ctx.hdl) == 0)
			{
				found = 1;
				break;
			}
		}
	}
	if(!found)
		return 0;
	return fel_init(&g_ctx);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_open(void)
{
	if(g_open)
		return 1;
	if(!api_find_and_open())
	{
		if(g_ctx.hdl)
		{
			libusb_close(g_ctx.hdl);
			g_ctx.hdl = NULL;
		}
		return 0;
	}
	g_open = 1;
	return 1;
}

EMSCRIPTEN_KEEPALIVE void xfel_api_close(void)
{
	if(g_ctx.hdl)
	{
		libusb_close(g_ctx.hdl);
		g_ctx.hdl = NULL;
	}
	g_open = 0;
}

EMSCRIPTEN_KEEPALIVE int xfel_api_is_open(void)
{
	return g_open;
}

/*
 * chip information, valid after a successful xfel_api_open()
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_get_chip_name(char * buf, int len)
{
	if(!g_open || !g_ctx.chip || !buf || (len <= 0))
		return 0;
	strncpy(buf, g_ctx.chip->name, len - 1);
	buf[len - 1] = '\0';
	return 1;
}

EMSCRIPTEN_KEEPALIVE int xfel_api_get_magic(char * buf, int len)
{
	if(!g_open || !buf || (len < 9))
		return 0;
	memcpy(buf, g_ctx.version.magic, 8);
	buf[8] = '\0';
	return 1;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_id(void)
{
	return g_open ? g_ctx.version.id : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_firmware(void)
{
	return g_open ? g_ctx.version.firmware : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_protocol(void)
{
	return g_open ? g_ctx.version.protocol : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_dflag(void)
{
	return g_open ? g_ctx.version.dflag : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_dlength(void)
{
	return g_open ? g_ctx.version.dlength : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t xfel_api_get_scratchpad(void)
{
	return g_open ? g_ctx.version.scratchpad : 0;
}

/*
 * memory access
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_read32(uint32_t addr, uint32_t * val)
{
	if(!g_open || !val)
		return 0;
	return fel_chip_read32(&g_ctx, addr, val);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_write32(uint32_t addr, uint32_t val)
{
	if(!g_open)
		return 0;
	return fel_chip_write32(&g_ctx, addr, val);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_read(uint32_t addr, uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	fel_read_progress(&g_ctx, addr, buf, len);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int xfel_api_write(uint32_t addr, const uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	fel_write_progress(&g_ctx, addr, (void *)buf, len);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int xfel_api_exec(uint32_t addr)
{
	if(!g_open)
		return 0;
	fel_exec(&g_ctx, addr);
	return 1;
}

/*
 * hexdump, same word-wise read as main.c's fel_chip_read_buf() followed
 * by misc.c's hexdump(); the formatted output goes to stdout (onLog)
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_hexdump(uint32_t addr, uint32_t len)
{
	uint8_t * buf;

	if(!g_open)
		return 0;
	buf = (uint8_t *)malloc(len ? len : 1);
	if(!buf)
		return 0;
	uint32_t start = addr & ~0x3;
	uint32_t end = (addr + len + 0x3) & ~0x3;
	for(uint32_t p = start; p < end; p += 4)
	{
		uint32_t val;
		if(!fel_chip_read32(&g_ctx, p, &val))
			break;
		uint32_t s = (p > addr) ? p : addr;
		uint32_t e = (p + 4 < addr + len) ? p + 4 : addr + len;
		for(uint32_t q = s; q < e; q++)
			buf[q - addr] = (val >> ((q - p) * 8)) & 0xff;
	}
	hexdump(addr, buf, len);
	free(buf);
	return 1;
}

/*
 * chip level commands
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_reset(void)
{
	if(!g_open)
		return 0;
	return fel_chip_reset(&g_ctx);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_jtag(void)
{
	if(!g_open)
		return 0;
	return fel_chip_jtag(&g_ctx);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_sid(char * buf, int len)
{
	if(!g_open || !buf || (len <= 0))
		return 0;
	if(!fel_chip_sid(&g_ctx, buf))
		return 0;
	buf[len - 1] = '\0';
	return 1;
}

EMSCRIPTEN_KEEPALIVE int xfel_api_ddr(const char * type)
{
	if(!g_open)
		return 0;
	return fel_chip_ddr(&g_ctx, type ? type : "");
}

/*
 * spi nor flash, addresses and lengths are 32 bits (practical flash
 * sizes fit); detected capacity is reported as 64 bits
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_spinor_detect(char * name, int namelen, uint64_t * capacity)
{
	if(!g_open || !name || (namelen <= 0) || !capacity)
		return 0;
	name[0] = '\0';
	*capacity = 0;
	return spinor_detect(&g_ctx, name, capacity);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinor_erase(uint32_t addr, uint32_t len)
{
	if(!g_open)
		return 0;
	return spinor_erase(&g_ctx, addr, len);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinor_read(uint32_t addr, uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	return spinor_read(&g_ctx, addr, buf, len);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinor_write(uint32_t addr, const uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	return spinor_write(&g_ctx, addr, (void *)buf, len);
}

/*
 * spi nand flash
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_spinand_detect(char * name, int namelen, uint64_t * capacity)
{
	if(!g_open || !name || (namelen <= 0) || !capacity)
		return 0;
	name[0] = '\0';
	*capacity = 0;
	return spinand_detect(&g_ctx, name, capacity);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinand_erase(uint32_t addr, uint32_t len)
{
	if(!g_open)
		return 0;
	return spinand_erase(&g_ctx, addr, len);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinand_read(uint32_t addr, uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	return spinand_read(&g_ctx, addr, buf, len);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinand_write(uint32_t addr, const uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	return spinand_write(&g_ctx, addr, (void *)buf, len);
}

EMSCRIPTEN_KEEPALIVE int xfel_api_spinand_splwrite(uint32_t splitsz, uint32_t addr, const uint8_t * buf, uint32_t len)
{
	if(!g_open || !buf)
		return 0;
	return spinand_splwrite(&g_ctx, splitsz, addr, (void *)buf, len);
}

/*
 * ecdsa256 signature for sha256 of sid, same defaults as main.c
 */
EMSCRIPTEN_KEEPALIVE int xfel_api_sign(const char * pubhex, const char * privhex, uint8_t * out)
{
	uint8_t public_key[33] = {
		0x03, 0xcf, 0xd1, 0x8e, 0x4a, 0x4b, 0x40, 0xd6,
		0x52, 0x94, 0x48, 0xaa, 0x2d, 0xf8, 0xbb, 0xb6,
		0x77, 0x12, 0x82, 0x58, 0xb8, 0xfb, 0xfc, 0x5b,
		0x9e, 0x49, 0x2f, 0xbb, 0xba, 0x4e, 0x84, 0x83,
		0x2f,
	};
	uint8_t private_key[32] = {
		0xdc, 0x57, 0xb8, 0xa9, 0xe0, 0xe2, 0xb7, 0xf8,
		0xb4, 0xc9, 0x29, 0xbd, 0x8d, 0xb2, 0x84, 0x4e,
		0x53, 0xf0, 0x1f, 0x17, 0x1b, 0xbc, 0xdf, 0x6e,
		0x62, 0x89, 0x08, 0xdb, 0xf2, 0xb2, 0xe6, 0xa9,
	};
	uint8_t sha256[32];
	uint8_t signature[64];
	char sid[256];

	if(!g_open || !out)
		return 0;
	if(!fel_chip_sid(&g_ctx, sid))
		return 0;
	if(pubhex && (strlen(pubhex) == sizeof(public_key) * 2))
	{
		for(int i = 0; i < sizeof(public_key); i++)
			public_key[i] = hex_string(pubhex, i * 2);
	}
	if(privhex && (strlen(privhex) == sizeof(private_key) * 2))
	{
		for(int i = 0; i < sizeof(private_key); i++)
			private_key[i] = hex_string(privhex, i * 2);
	}
	sha256_hash(sid, strlen(sid), sha256);
	ecdsa256_sign(private_key, sha256, signature);
	if(!ecdsa256_verify(public_key, sha256, signature))
		return 0;
	memcpy(out, signature, sizeof(signature));
	return 1;
}
