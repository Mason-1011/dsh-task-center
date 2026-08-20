/**
 * Build the single publishable package: the ten server plugins esbuild-bundled
 * with code splitting (their runtime cross-imports land in shared chunks, so
 * each plugin module stays a single instance), plus one merged web client
 * bundle carrying both the kanban and the scheduler surfaces. The family
 * workspace packages are inlined; the @deepseek-ai peers and zod stay external
 * so they resolve against the dsh profile's module farm at runtime.
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = resolve(root, '..')

/** Server entry of each plugin package, by the row/export name it ships as. */
const SERVER_ENTRIES = {
  index: 'task-web/dist/index.js',
  'plugins/task': 'task/dist/index.js',
  'plugins/task-local': 'task-local/dist/index.js',
  'plugins/task-source': 'task-source/dist/index.js',
  'plugins/tool-task': 'tool-task/dist/index.js',
  'plugins/command-task': 'command-task/dist/index.js',
  'plugins/task-wake': 'task-wake/dist/index.js',
  'plugins/task-quota': 'task-quota/dist/index.js',
  'plugins/task-reaper': 'task-reaper/dist/index.js',
  'plugins/task-sched': 'task-sched/dist/index.js',
}

await build({
  entryPoints: Object.fromEntries(
    Object.entries(SERVER_ENTRIES).map(([out, dist]) => [out, resolve(pluginsRoot, dist)]),
  ),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outdir: resolve(root, 'dist'),
  chunkNames: 'chunks/[hash]',
  // Everything dsh provides resolves through the profile's module farm; only
  // the family's own cross-imports may be inlined.
  external: ['@deepseek-ai/*', 'zod'],
  logLevel: 'warning',
})

// ---- merged client bundle -------------------------------------------------

const SEEDS = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])

const result = await build({
  entryPoints: [resolve(root, 'src/client-merged.ts')],
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
  throw new Error(`client bundle requires non-seed modules: ${[...new Set(offenders)].join(', ')}`)
}

const envelope = `window.__ModuleLoader__.load({
  id: "dsh-task-center",
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
console.log(`bundle: server ${Object.keys(SERVER_ENTRIES).length} entries, client ${(envelope.length / 1024).toFixed(1)} kB, client requires: ${specs.join(', ') || 'none'}`)
