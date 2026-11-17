/**
 * Bundle the browser half into the single ModuleLoader artifact DSH serves.
 *
 * React stays external (the client module table provides it); Cytoscape and
 * fcose are bundled so the plugin has no runtime dependency resolution. The
 * wrapper matches what `tsdown` emits for the first-party client packages.
 */
import { build, context } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist/client.js');
const banner =
  'window.__ModuleLoader__.load({id:"dsh-knowledge-graph",factory:require=>{var module={exports:{}};var exports=module.exports;\n';
const footer = '\nreturn module.exports;}});\n';

const options = {
  entryPoints: [resolve(root, 'src/client/index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'edge120', 'firefox120', 'safari17'],
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  write: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

/** Write the wrapped bundle. */
async function writeOutput(result) {
  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error('esbuild produced no output');
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, `${banner}${output.text}${footer}`, 'utf8');
}

if (process.argv.includes('--watch')) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'write-module-loader-wrapper',
        setup(buildApi) {
          buildApi.onEnd(async (result) => {
            if (result.errors.length === 0) await writeOutput(result);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log(`watching ${outfile}`);
} else {
  const result = await build(options);
  await writeOutput(result);
  console.log(`wrote ${outfile}`);
}
