/**
 * Set one version across the root and every publishable package — the family
 * shares a single version, the dsh family's convention. Usage:
 * `node scripts/bump.mjs 0.1.1`.
 * @module scripts/bump
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/bump.mjs <version>  (e.g. 0.1.1)')
  process.exit(1)
}

/** Directories whose package.json is published; root and shell stay out. */
const PUBLISHED = [
  'packages/bundle', 'packages/bundle-headless',
  'packages/command-task', 'packages/task', 'packages/task-local',
  'packages/task-quota', 'packages/task-reaper', 'packages/task-sched',
  'packages/task-source', 'packages/task-wake', 'packages/task-web',
  'packages/tool-task',
]

for (const dir of ['.', ...PUBLISHED]) {
  const file = join(root, dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = version
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${dir === '.' ? '(root)' : dir}: ${version}`)
}
