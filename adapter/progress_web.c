/*
 * progress reporting for the web (wasm) build.
 *
 * This is a drop-in replacement for progress.c (excluded from the wasm
 * build) which keeps the exact same console output, but additionally
 * reports the ratio to Module.onProgress so web frontends can render a
 * progress bar.
 */

#include <progress.h>
#include <sys/time.h>
#include <emscripten.h>

EM_JS(void, xfel_js_progress, (double ratio, double done, double total), {
	if(Module.onProgress)
		Module.onProgress(ratio, done, total);
});

static double gettime(void)
{
	struct timeval tv;
	gettimeofday(&tv, NULL);
	return tv.tv_sec + (double)tv.tv_usec / 1000000.0;
}

static const char * format_eta(double remaining)
{
	static char result[6] = "";
	int seconds = remaining + 0.5;
	if(seconds >= 0 && seconds < 6000)
	{
		snprintf(result, sizeof(result), "%02d:%02d", seconds / 60, seconds % 60);
		return result;
	}
	return "--:--";
}

static char * ssize(char * buf, double size)
{
	const char * unit[] = {"B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"};
	int count = 0;

	while((size > 1024) && (count < 8))
	{
		size /= 1024;
		count++;
	}
	sprintf(buf, "%5.3f %s", size, unit[count]);
	return buf;
}

void progress_start(struct progress_t * p, uint64_t total)
{
	if(p && (total > 0))
	{
		p->total = total;
		p->done = 0;
		p->start = gettime();
		xfel_js_progress(0.0, 0.0, total);
	}
}

void progress_update(struct progress_t * p, uint64_t bytes)
{
	char buf1[32], buf2[32];

	if(p)
	{
		p->done += bytes;
		double ratio = p->total > 0 ? (double)p->done / (double)p->total : 0.0;
		double speed = (double)p->done / (gettime() - p->start);
		double eta = speed > 0 ? (p->total - p->done) / speed : 0;
		int i, pos = 48 * ratio;
		printf("\r%3.0f%% [", ratio * 100);
		for(i = 0; i < pos; i++)
			putchar('=');
		for(i = pos; i < 48; i++)
			putchar(' ');
		if(p->done < p->total)
			printf("] %s/s, ETA %s        \r", ssize(buf1, speed), format_eta(eta));
		else
			printf("] %s, %s/s        \r", ssize(buf1, p->done), ssize(buf2, speed));
		fflush(stdout);
		xfel_js_progress(ratio, (double)p->done, (double)p->total);
	}
}

void progress_stop(struct progress_t * p)
{
	if(p)
	{
		printf("\r\n");
		xfel_js_progress(1.0, (double)p->done, (double)p->total);
	}
}
