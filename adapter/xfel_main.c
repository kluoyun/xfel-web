/*
 * web (wasm) entry point.
 *
 * Instead of a real argv, the browser passes a single command line
 * string. xfel_run() tokenizes it and calls the unchanged main() from
 * main.c, so every xfel command is available through one exported
 * function:
 *
 *   const r = await Module._xfel_run("version");
 *
 * The returned value is main()'s exit code (0 on success).
 */

#include <x.h>
#include <misc.h>
#include <emscripten.h>

extern int main(int argc, char * argv[]);

#define XFEL_ARGC_MAX	64
#define XFEL_CMD_MAX	2048

EMSCRIPTEN_KEEPALIVE int xfel_run(const char * cmdline)
{
	static char cmd[XFEL_CMD_MAX];
	static char * argv[XFEL_ARGC_MAX];
	int argc = 0;

	strncpy(cmd, cmdline ? cmdline : "", sizeof(cmd) - 1);
	cmd[sizeof(cmd) - 1] = '\0';

	argv[argc++] = (char *)"xfel";
	for(char * p = strtok(cmd, " \t"); p && (argc < XFEL_ARGC_MAX); p = strtok(NULL, " \t"))
		argv[argc++] = p;

	int rc = main(argc, argv);
	/* main() returns instead of exiting the process, flush stdio here */
	fflush(NULL);
	return rc;
}
