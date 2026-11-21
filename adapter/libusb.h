#ifndef __LIBUSB_WEBUSB_SHIM_H__
#define __LIBUSB_WEBUSB_SHIM_H__

/*
 * libusb-1.0 compatible shim header for the web (wasm) build.
 *
 * This header shadows the real <libusb.h> when building with emscripten
 * (the wasm makefile puts "-I adapter" before "-I ."). It declares the
 * subset of the libusb-1.0 API that xfel actually uses, and the
 * implementation in libusb_webusb.c routes everything to a JavaScript
 * USB backend (see glue/src/usb-backend.ts) through emscripten's
 * EM_JS / EM_ASYNC_JS bridges.
 */

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <sys/types.h>

/*
 * error codes (subset of libusb-1.0)
 */
enum libusb_error
{
	LIBUSB_SUCCESS				= 0,
	LIBUSB_ERROR_IO				= -1,
	LIBUSB_ERROR_INVALID_PARAM	= -2,
	LIBUSB_ERROR_ACCESS			= -3,
	LIBUSB_ERROR_NO_DEVICE		= -4,
	LIBUSB_ERROR_NOT_FOUND		= -5,
	LIBUSB_ERROR_BUSY			= -6,
	LIBUSB_ERROR_TIMEOUT		= -7,
	LIBUSB_ERROR_OVERFLOW		= -8,
	LIBUSB_ERROR_PIPE			= -9,
	LIBUSB_ERROR_INTERRUPTED	= -10,
	LIBUSB_ERROR_NO_MEM			= -11,
	LIBUSB_ERROR_NOT_SUPPORTED	= -12,
	LIBUSB_ERROR_OTHER			= -99,
};

/*
 * endpoint direction
 */
#define LIBUSB_ENDPOINT_IN			0x80
#define LIBUSB_ENDPOINT_OUT			0x00
#define LIBUSB_ENDPOINT_DIR_MASK	0x80

/*
 * transfer type (in bmAttributes)
 */
enum libusb_transfer_type
{
	LIBUSB_TRANSFER_TYPE_CONTROL	= 0,
	LIBUSB_TRANSFER_TYPE_ISOCHRONOUS	= 1,
	LIBUSB_TRANSFER_TYPE_BULK		= 2,
	LIBUSB_TRANSFER_TYPE_INTERRUPT	= 3,
};
#define LIBUSB_TRANSFER_TYPE_MASK	0x03

/*
 * opaque types, same usage as libusb-1.0
 */
typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;

/*
 * standard usb device descriptor, byte-identical to the wire layout
 */
struct libusb_device_descriptor {
	uint8_t  bLength;
	uint8_t  bDescriptorType;
	uint16_t bcdUSB;
	uint8_t  bDeviceClass;
	uint8_t  bDeviceSubClass;
	uint8_t  bDeviceProtocol;
	uint8_t  bMaxPacketSize0;
	uint16_t idVendor;
	uint16_t idProduct;
	uint16_t bcdDevice;
	uint8_t  iManufacturer;
	uint8_t  iProduct;
	uint8_t  iSerialNumber;
	uint8_t  bNumConfigurations;
} __attribute__((packed));

/*
 * standard usb endpoint descriptor, byte-identical to the wire layout,
 * so it can point directly into a raw descriptor blob
 */
struct libusb_endpoint_descriptor {
	uint8_t  bLength;
	uint8_t  bDescriptorType;
	uint8_t  bEndpointAddress;
	uint8_t  bmAttributes;
	uint16_t wMaxPacketSize;
	uint8_t  bInterval;
} __attribute__((packed));

/*
 * libusb style interface descriptor: the first 9 bytes follow the wire
 * layout, followed by the endpoint array pointer
 */
struct libusb_interface_descriptor {
	uint8_t  bLength;
	uint8_t  bDescriptorType;
	uint8_t  bInterfaceNumber;
	uint8_t  bAlternateSetting;
	uint8_t  bNumEndpoints;
	uint8_t  bInterfaceClass;
	uint8_t  bInterfaceSubClass;
	uint8_t  bInterfaceProtocol;
	uint8_t  iInterface;
	const struct libusb_endpoint_descriptor * endpoint;
} __attribute__((packed));

struct libusb_interface {
	int num_altsetting;
	const struct libusb_interface_descriptor * altsetting;
};

/*
 * libusb style config descriptor
 */
struct libusb_config_descriptor {
	uint8_t  bLength;
	uint8_t  bDescriptorType;
	uint16_t wTotalLength;
	uint8_t  bNumInterfaces;
	uint8_t  bConfigurationValue;
	uint8_t  iConfiguration;
	uint8_t  bmAttributes;
	uint8_t  bMaxPower;
	const struct libusb_interface * interface;
	const unsigned char * extra;
	int extra_length;
};

/*
 * api (subset used by xfel)
 */
int libusb_init(libusb_context ** ctx);
void libusb_exit(libusb_context * ctx);

int libusb_get_device_list(libusb_context * ctx, libusb_device *** list);
void libusb_free_device_list(libusb_device ** list, int unref_devices);

int libusb_get_device_descriptor(libusb_device * dev, struct libusb_device_descriptor * desc);
int libusb_get_active_config_descriptor(libusb_device * dev, struct libusb_config_descriptor ** config);
void libusb_free_config_descriptor(struct libusb_config_descriptor * config);

int libusb_open(libusb_device * dev, libusb_device_handle ** handle);
void libusb_close(libusb_device_handle * handle);
libusb_device * libusb_get_device(libusb_device_handle * handle);

int libusb_kernel_driver_active(libusb_device_handle * handle, int interface_number);
int libusb_detach_kernel_driver(libusb_device_handle * handle, int interface_number);
int libusb_claim_interface(libusb_device_handle * handle, int interface_number);

int libusb_bulk_transfer(libusb_device_handle * handle, unsigned char endpoint, unsigned char * data, int length, int * transferred, unsigned int timeout);

#ifdef __cplusplus
}
#endif

#endif /* __LIBUSB_WEBUSB_SHIM_H__ */
