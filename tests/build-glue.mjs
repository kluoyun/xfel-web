/*
 * Bundle the in-app TypeScript glue layer (src/lib/xfel) for the node
 * tests. The emscripten module (build/xfel.js, produced by `make`) is
 * imported relatively and gets inlined by esbuild.
 */
import * as esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['src/lib/xfel/index.ts'],
	outfile: 'tests/.build/glue.mjs',
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	logLevel: 'info',
});

await esbuild.build({
	entryPoints: ['src/lib/terminal-buffer.ts'],
	outfile: 'tests/.build/terminal-buffer.mjs',
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	logLevel: 'info',
});
