/*
 * libusb-1.0 compatible shim implementation for the web (wasm) build.
 *
 * Every libusb call used by xfel is routed to a JavaScript USB backend
 * (Module.xfelUsb, implemented in glue/src/usb-backend.ts with WebUSB)
 * through emscripten's EM_JS / EM_ASYNC_JS bridges. WebUSB transfers are
 * asynchronous, so this file requires building with -sASYNCIFY.
 *
 * Session semantics: libusb_exit() and libusb_close() do not release the
 * underlying WebUSB device, so an xfel command issued through
 * xfel_run() can reuse the already claimed interface on the next call.
 * Use the backend's disconnect() (XFel.disconnect() in typescript) to
 * close the device for real.
 */

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "libusb.h"

struct webusb_device_s {
	int id;
};

struct webusb_handle_s {
	struct webusb_device_s * dev;
};

static libusb_device ** g_list = NULL;
static int g_count = 0;

/*
 * Device entries are kept in a persistent registry and never freed:
 * open handles (including the persistent session of xfel_api) keep
 * pointing at their entry across device list rescans - main() rescans
 * the list on every xfel_run() and would otherwise dangle the session.
 */
static struct webusb_device_s * g_devs = NULL;
static int g_devs_cap = 0;
static int g_devs_used = 0;

static struct webusb_device_s * get_device_by_id(int id)
{
	for(int i = 0; i < g_devs_used; i++)
	{
		if(g_devs[i].id == id)
			return &g_devs[i];
	}
	if(g_devs_used >= g_devs_cap)
	{
		int cap = g_devs_cap ? g_devs_cap * 2 : 8;
		struct webusb_device_s * devs = (struct webusb_device_s *)realloc(g_devs, cap * sizeof(struct webusb_device_s));
		if(!devs)
			return NULL;
		g_devs = devs;
		g_devs_cap = cap;
	}
	g_devs[g_devs_used].id = id;
	return &g_devs[g_devs_used++];
}

/*
 * javascript bridge
 */
EM_ASYNC_JS(int, xfel_usb_refresh, (void), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -1;
	return (await backend.refresh()) ? 0 : -1;
});

EM_JS(int, xfel_usb_device_count, (void), {
	const backend = Module.xfelUsb;
	return backend ? backend.deviceCount() : 0;
});

EM_JS(int, xfel_usb_device_id, (int index), {
	return Module.xfelUsb.deviceId(index);
});

EM_ASYNC_JS(int, xfel_usb_open, (int id), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -1;
	return (await backend.open(id)) ? 0 : -1;
});

EM_ASYNC_JS(int, xfel_usb_device_descriptor, (int id, int ptr), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -1;
	const d = backend.deviceDescriptor(id);
	if(!(d instanceof Uint8Array))
		return -1;
	HEAPU8.set(d, ptr);
	return d.length;
});

EM_JS(int, xfel_usb_config_descriptor_size, (int id), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -1;
	const d = backend.configDescriptor(id);
	return d instanceof Uint8Array ? d.length : -1;
});

EM_JS(int, xfel_usb_config_descriptor_bytes, (int id, int ptr, int max), {
	const d = Module.xfelUsb.configDescriptor(id);
	const n = Math.min(d.length, max);
	HEAPU8.set(d.subarray(0, n), ptr);
	return n;
});

EM_ASYNC_JS(int, xfel_usb_bulk_out, (int id, int ep, int ptr, int len, int timeout), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -99;
	return await backend.bulkOut(id, ep, HEAPU8.subarray(ptr, ptr + len), timeout);
});

EM_ASYNC_JS(int, xfel_usb_bulk_in, (int id, int ep, int ptr, int len, int timeout), {
	const backend = Module.xfelUsb;
	if(!backend)
		return -99;
	const d = await backend.bulkIn(id, ep, len, timeout);
	if(!d)
		return -9;
	HEAPU8.set(d, ptr);
	return d.length;
});

static void free_device_list(void)
{
	/* only the list array is freed here - the device entries stay in
	 * the persistent registry so open handles remain valid */
	if(g_list)
	{
		free(g_list);
		g_list = NULL;
	}
	g_count = 0;
}

int libusb_init(libusb_context ** ctx)
{
	if(xfel_usb_refresh() != 0)
		return LIBUSB_ERROR_OTHER;
	if(ctx)
		*ctx = (libusb_context *)(void *)1;
	return LIBUSB_SUCCESS;
}

void libusb_exit(libusb_context * ctx)
{
	(void)ctx;
	/* keep the javascript side alive for the next xfel_run() */
	free_device_list();
}

int libusb_get_device_list(libusb_context * ctx, libusb_device *** list)
{
	(void)ctx;
	free_device_list();

	int n = xfel_usb_device_count();
	if(n > 0)
	{
		g_list = (libusb_device **)malloc(n * sizeof(libusb_device *));
		if(!g_list)
			return LIBUSB_ERROR_NO_MEM;
		for(int i = 0; i < n; i++)
		{
			struct webusb_device_s * d = get_device_by_id(xfel_usb_device_id(i));
			if(!d)
			{
				g_count = i;
				free_device_list();
				return LIBUSB_ERROR_NO_MEM;
			}
			g_list[i] = (libusb_device *)d;
		}
	}
	g_count = n;
	if(list)
		*list = g_list;
	return g_count;
}

void libusb_free_device_list(libusb_device ** list, int unref_devices)
{
	(void)unref_devices;
	if(list != g_list)
	{
		/* only the list cached by libusb_get_device_list() is owned here */
		return;
	}
	free_device_list();
}

int libusb_get_device_descriptor(libusb_device * dev, struct libusb_device_descriptor * desc)
{
	struct webusb_device_s * d = (struct webusb_device_s *)dev;
	if(!d)
		return LIBUSB_ERROR_INVALID_PARAM;

	uint8_t raw[18];
	int n = xfel_usb_device_descriptor(d->id, (int)(intptr_t)raw);
	if(n != sizeof(raw))
		return LIBUSB_ERROR_OTHER;
	memcpy(desc, raw, sizeof(*desc));
	return LIBUSB_SUCCESS;
}

int libusb_get_active_config_descriptor(libusb_device * dev, struct libusb_config_descriptor ** config)
{
#define MAX_IFACES		8
#define MAX_ALTSETTINGS	16
#define MAX_ENDPOINTS	16

	struct webusb_device_s * d = (struct webusb_device_s *)dev;
	if(!d)
		return LIBUSB_ERROR_INVALID_PARAM;

	int len = xfel_usb_config_descriptor_size(d->id);
	if(len < 9)
		return LIBUSB_ERROR_NOT_FOUND;

	uint8_t * raw = (uint8_t *)malloc(len);
	if(!raw)
		return LIBUSB_ERROR_NO_MEM;
	int got = xfel_usb_config_descriptor_bytes(d->id, (int)(intptr_t)raw, len);
	if(got < 9)
	{
		free(raw);
		return LIBUSB_ERROR_OTHER;
	}

	int total = raw[2] | (raw[3] << 8);
	if((total < 9) || (total > got))
		total = got;

	int iface_off[MAX_IFACES];
	struct {
		int iface_idx;
		int off;
		int ep_off0;
		int ep_count;
	} alts[MAX_ALTSETTINGS];
	int ep_off[MAX_ENDPOINTS];
	int niface = 0, nalts = 0, neps = 0;
	int cur_iface = -1;

	for(int off = 9; (off + 2 <= total); off += raw[off])
	{
		if(raw[off] < 2)
			break;
		int type = raw[off + 1];
		if(type == 0x04)
		{
			int num = raw[off + 2];
			if(num != cur_iface)
			{
				if(niface >= MAX_IFACES)
					break;
				cur_iface = num;
				iface_off[niface++] = off;
			}
			if(nalts >= MAX_ALTSETTINGS)
				break;
			alts[nalts].iface_idx = niface - 1;
			alts[nalts].off = off;
			alts[nalts].ep_off0 = -1;
			alts[nalts].ep_count = 0;
			nalts++;
		}
		else if(type == 0x05)
		{
			if(neps >= MAX_ENDPOINTS)
				break;
			if(nalts > 0)
			{
				if(alts[nalts - 1].ep_count == 0)
					alts[nalts - 1].ep_off0 = off;
				alts[nalts - 1].ep_count++;
			}
			ep_off[neps++] = off;
		}
	}

	if(niface == 0 || nalts == 0)
	{
		free(raw);
		return LIBUSB_ERROR_NOT_FOUND;
	}

	size_t arena_size = sizeof(struct libusb_config_descriptor)
		+ (size_t)niface * sizeof(struct libusb_interface)
		+ (size_t)nalts * sizeof(struct libusb_interface_descriptor)
		+ (size_t)len;
	uint8_t * arena = (uint8_t *)malloc(arena_size);
	if(!arena)
	{
		free(raw);
		return LIBUSB_ERROR_NO_MEM;
	}

	uint8_t * blob = arena + sizeof(struct libusb_config_descriptor)
		+ (size_t)niface * sizeof(struct libusb_interface)
		+ (size_t)nalts * sizeof(struct libusb_interface_descriptor);
	memcpy(blob, raw, len);
	free(raw);

	struct libusb_config_descriptor * c = (struct libusb_config_descriptor *)arena;
	memset(c, 0, sizeof(*c));
	c->bLength = blob[0];
	c->bDescriptorType = blob[1];
	c->wTotalLength = (uint16_t)total;
	c->bNumInterfaces = (uint8_t)niface;
	c->bConfigurationValue = blob[5];
	c->iConfiguration = blob[6];
	c->bmAttributes = blob[7];
	c->bMaxPower = blob[8];
	c->extra = NULL;
	c->extra_length = 0;

	struct libusb_interface * ifaces = (struct libusb_interface *)(arena + sizeof(struct libusb_config_descriptor));
	struct libusb_interface_descriptor * ifdescs = (struct libusb_interface_descriptor *)(blob - (size_t)nalts * sizeof(struct libusb_interface_descriptor));
	c->interface = ifaces;

	for(int i = 0; i < niface; i++)
	{
		ifaces[i].num_altsetting = 0;
		ifaces[i].altsetting = NULL;
	}
	for(int i = 0; i < nalts; i++)
	{
		const uint8_t * di = blob + alts[i].off;
		struct libusb_interface_descriptor * s = &ifdescs[i];
		memset(s, 0, sizeof(*s));
		s->bLength = di[0];
		s->bDescriptorType = di[1];
		s->bInterfaceNumber = di[2];
		s->bAlternateSetting = di[3];
		s->bNumEndpoints = di[4];
		s->bInterfaceClass = di[5];
		s->bInterfaceSubClass = di[6];
		s->bInterfaceProtocol = di[7];
		s->iInterface = di[8];
		s->endpoint = (alts[i].ep_count > 0)
			? (const struct libusb_endpoint_descriptor *)(blob + alts[i].ep_off0)
			: NULL;
		ifaces[alts[i].iface_idx].num_altsetting++;
		if(ifaces[alts[i].iface_idx].altsetting == NULL)
			ifaces[alts[i].iface_idx].altsetting = s;
	}

	*config = c;
	return LIBUSB_SUCCESS;
#undef MAX_IFACES
#undef MAX_ALTSETTINGS
#undef MAX_ENDPOINTS
}

void libusb_free_config_descriptor(struct libusb_config_descriptor * config)
{
	free(config);
}

int libusb_open(libusb_device * dev, libusb_device_handle ** handle)
{
	struct webusb_device_s * d = (struct webusb_device_s *)dev;
	if(!d)
		return LIBUSB_ERROR_INVALID_PARAM;

	int r = xfel_usb_open(d->id);
	if(r != 0)
		return LIBUSB_ERROR_OTHER;

	struct webusb_handle_s * h = (struct webusb_handle_s *)malloc(sizeof(struct webusb_handle_s));
	if(!h)
		return LIBUSB_ERROR_NO_MEM;
	h->dev = d;
	if(handle)
		*handle = (libusb_device_handle *)h;
	return LIBUSB_SUCCESS;
}

void libusb_close(libusb_device_handle * handle)
{
	/*
	 * only release the wrapper, the underlying WebUSB device stays
	 * opened and claimed so the next command reuses the session
	 */
	free(handle);
}

libusb_device * libusb_get_device(libusb_device_handle * handle)
{
	struct webusb_handle_s * h = (struct webusb_handle_s *)handle;
	if(!h)
		return NULL;
	return (libusb_device *)h->dev;
}

int libusb_kernel_driver_active(libusb_device_handle * handle, int interface_number)
{
	(void)handle;
	(void)interface_number;
	return 0;
}

int libusb_detach_kernel_driver(libusb_device_handle * handle, int interface_number)
{
	(void)handle;
	(void)interface_number;
	return 0;
}

int libusb_claim_interface(libusb_device_handle * handle, int interface_number)
{
	(void)handle;
	(void)interface_number;
	/* the javascript backend claims interface 0 in open() */
	return LIBUSB_SUCCESS;
}

int libusb_bulk_transfer(libusb_device_handle * handle, unsigned char endpoint, unsigned char * data, int length, int * transferred, unsigned int timeout)
{
	struct webusb_handle_s * h = (struct webusb_handle_s *)handle;
	if(!h || !h->dev)
		return LIBUSB_ERROR_NO_DEVICE;

	int r;
	if(endpoint & LIBUSB_ENDPOINT_DIR_MASK)
		r = xfel_usb_bulk_in(h->dev->id, endpoint, (int)(intptr_t)data, length, (int)timeout);
	else
		r = xfel_usb_bulk_out(h->dev->id, endpoint, (int)(intptr_t)data, length, (int)timeout);
	if(r < 0)
		return r;
	if(transferred)
		*transferred = r;
	return LIBUSB_SUCCESS;
}
