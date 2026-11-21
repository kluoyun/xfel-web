#
# xfel-web: run xfel in the browser over WebUSB.
#
# The original xfel sources are imported as a git submodule (xfel/) and
# compiled unmodified; all platform-specific behavior lives in adapter/.
#
# Debug workflow:
#   make               build the wasm module (build/xfel.js)
#   npm run dev        vite dev server with hot reload
#   npm run build      production frontend build (dist/)
#
# Tests (node, no hardware needed):
#   make test          command line path (xfel_run) against a mock device
#   make test-glue     direct C API path through the TypeScript glue layer
#

EMCC		?= emcc
NODE		?= $(shell command -v node 2>/dev/null || echo node)
XFEL		:= xfel

OUTDIR		:= build

# The adapter directory shadows <libusb.h> with the WebUSB shim, so it
# must come before the submodule source directory.
INCDIRS		:= -I adapter -I $(XFEL) -I .

CFLAGS		:= -Wall -O3 -D__linux__ $(INCDIRS)

SRCS		:= $(filter-out $(XFEL)/progress.c, $(wildcard $(XFEL)/*.c) $(wildcard $(XFEL)/chips/*.c)) $(wildcard adapter/*.c)

COMMONFLAGS	:= \
	-sASYNCIFY \
	-sASYNCIFY_STACK_SIZE=32768 \
	-sFORCE_FILESYSTEM \
	-sALLOW_MEMORY_GROWTH \
	-sINVOKE_RUN=0 \
	-sEXPORTED_FUNCTIONS=_xfel_run,_malloc,_free,_xfel_api_open,_xfel_api_close,_xfel_api_is_open,_xfel_api_get_chip_name,_xfel_api_get_magic,_xfel_api_get_id,_xfel_api_get_firmware,_xfel_api_get_protocol,_xfel_api_get_dflag,_xfel_api_get_dlength,_xfel_api_get_scratchpad,_xfel_api_read32,_xfel_api_write32,_xfel_api_read,_xfel_api_write,_xfel_api_exec,_xfel_api_hexdump,_xfel_api_reset,_xfel_api_jtag,_xfel_api_sid,_xfel_api_ddr,_xfel_api_spinor_detect,_xfel_api_spinor_erase,_xfel_api_spinor_read,_xfel_api_spinor_write,_xfel_api_spinand_detect,_xfel_api_spinand_erase,_xfel_api_spinand_read,_xfel_api_spinand_write,_xfel_api_spinand_splwrite,_xfel_api_sign \
	-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP8,HEAP16,HEAP32,HEAPU32,stringToUTF8,UTF8ToString,lengthBytesUTF8,FS,ccall \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1

WEBFLAGS	:= $(COMMONFLAGS) \
	-sSINGLE_FILE=1 \
	-sENVIRONMENT=web

NODEFLAGS	:= $(COMMONFLAGS) \
	-sENVIRONMENT=node

.PHONY:		all web node test test-glue clean

all : web

web : $(OUTDIR)/xfel.js

node : $(OUTDIR)/xfel-node.js

$(OUTDIR)/xfel.js : $(SRCS) adapter/libusb.h Makefile
	@mkdir -p $(OUTDIR)
	@echo [EMCC] $@
	@$(EMCC) $(CFLAGS) $(WEBFLAGS) $(SRCS) -o $@

$(OUTDIR)/xfel-node.js : $(SRCS) adapter/libusb.h Makefile
	@mkdir -p $(OUTDIR)
	@echo [EMCC] $@
	@$(EMCC) $(CFLAGS) $(NODEFLAGS) $(SRCS) -o $@

test : $(OUTDIR)/xfel-node.js
	@echo "[TEST] command line path (xfel_run) against mock device"
	@$(NODE) tests/smoke.mjs

test-glue : $(OUTDIR)/xfel.js
	@echo "[TEST] direct C API path through the TypeScript glue layer"
	@$(NODE) tests/build-glue.mjs
	@$(NODE) tests/glue.mjs

clean :
	@rm -rf $(OUTDIR) dist node_modules tests/.build
