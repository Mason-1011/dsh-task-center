/**
 * Browser-bundle build for the kanban client half.
 *
 * esbuild bundles src/client into one classic script wrapped in the dsh
 * ModuleLoader envelope: `window.__ModuleLoader__.load({ id, factory })`. The
 * factory closes over its `require` parameter, so externals (platform seeds:
 * the react family and the official UI primitives) resolve to the loader's
 * shared instances instead of fresh globals; that is why this is NOT an iife.
 * The primitives seed is types-only here — the npm copy's CSS is stubbed, so
 * bundling it would render naked components. The trailing guard fails the
 * build if the bundle ever requires anything outside the seed list.
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEEDS = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [...SEEDS],
  minify: true,
  write: false,
  logLevel: 'warning',
})

let body = result.outputFiles[0].text
// esbuild's interop shim names the helper __require; the envelope's factory
// parameter is the real require, so normalize before wrapping.
body = body.replaceAll('__require(', 'require(')
const offenders = [...body.matchAll(/require\((["'])(.+?)\1\)/g)]
  .map(match => match[2])
  .filter(spec => !SEEDS.has(spec))
if (offenders.length > 0) {
  throw new Error(`task-web client bundle requires non-seed modules: ${[...new Set(offenders)].join(', ')}`)
}

const envelope = `window.__ModuleLoader__.load({
  id: "dsh-task-center-task-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body.split('\n').map(line => `    ${line}`).join('\n')}
    return module.exports;
  },
});
`

await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/client.js'), envelope, 'utf8')

const specs = [...new Set([...body.matchAll(/require\((["'])(.+?)\1\)/g)].map(match => match[2]))]
console.log(`task-web client bundle: ${(envelope.length / 1024).toFixed(1)} kB, requires: ${specs.join(', ') || 'none'}`)
