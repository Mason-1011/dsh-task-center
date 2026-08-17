#!/usr/bin/env node
/**
 * One-command launcher for the task mission control: resolve the data root,
 * load `.env`, and boot the full composition (cordis.yml) through the real
 * Loader — task seam, tools, commands, wake timer, quota guard, reaper, and
 * the interactive shell. Interactive terminals get the REPL; piped stdin ends
 * the process cleanly on EOF.
 * @module @task-center/shell/bin
 */

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-task-center'

installFailLoud(NAME)
loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    root: { type: 'string' },
  },
  strict: true,
})

// The ledger must outlive the terminal by default: ~/.dsh-task-center, not a
// cwd-relative directory that would fork a new store per launch directory.
const root = resolve(values.root ?? process.env['TASK_CENTER_ROOT'] ?? `${homedir()}/.dsh-task-center`)
mkdirSync(root, { recursive: true })
process.env['TASK_CENTER_ROOT'] = root

const config = resolve(dirname(fileURLToPath(import.meta.url)), '../cordis.yml')
const ctx = await boot(NAME, config)

// A TTY hands control to the shell plugin's REPL, which exits the process on
// /exit. Without one (pipes, snapshots), exit cleanly when stdin ends.
if (process.stdin.isTTY !== true) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => process.exit(0))
  })
  process.stdin.resume()
}
