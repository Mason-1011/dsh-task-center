#!/usr/bin/env node
/**
 * CLI entry: discover CC transcripts, parse + map + predict them, then (unless
 * --dry-run) optionally wipe the old import's ledger residue and materialize
 * the mapped logs as real dsh sessions. All task judgment stays with the
 * task-source sweep — this tool only translates format.
 *
 * Usage:
 *   node --experimental-transform-types packages/cc-import/src/cli.ts \
 *     [--cc-home DIR] [--sessions-root DIR] [--ledger-root DIR] \
 *     [--adopt-fallback DIR] [--compression zstd|none] [--project SUBSTRING] \
 *     [--dry-run] [--wipe-ledger]
 * @module @task-center/cc-import/cli
 */

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { parseCcSession } from './parse.ts'
import { mapCcSession } from './map.ts'
import { materializeSessions, ccSessionId } from './materialize.ts'
import type { MaterializeInput } from './materialize.ts'
import { predictSession, summarizePredictions } from './predict.ts'
import type { SessionPrediction } from './predict.ts'
import { wipeLedger } from './wipe.ts'
import { adoptWorkspaces } from './adopt.ts'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'

const args = parseArgs({
  allowPositionals: false,
  options: {
    'cc-home': { type: 'string', default: join(homedir(), '.claude', 'projects') },
    'sessions-root': { type: 'string', default: join(homedir(), '.dsh', 'sessions') },
    'ledger-root': { type: 'string', default: join(homedir(), '.dsh', 'storages') },
    'adopt-fallback': { type: 'string', default: join(homedir(), '.dsh', 'cc-imported') },
    compression: { type: 'string', default: 'zstd' },
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'wipe-ledger': { type: 'boolean', default: false },
  },
})

if (args.values.compression !== 'zstd' && args.values.compression !== 'none') {
  fail(`--compression must be zstd or none, got "${args.values.compression}"`)
}

/** Fail loud with exit code 1 — a CLI reports, it does not throw stacks. */
function fail(message: string): never {
  console.error(`cc-import: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const ccHome = args.values['cc-home']!
  const projectFilter = args.values.project
  const compression = args.values.compression as JsonlCompression

  // Discovery: one directory per project under cc-home, top-level .jsonl only —
  // subagent transcripts live under <uuid>/subagents/ and never count.
  const dirs = (await readdir(ccHome, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .filter(entry => projectFilter === undefined || entry.name.includes(projectFilter))
  const files: string[] = []
  for (const dir of dirs) {
    const entries = await readdir(join(ccHome, dir.name), { withFileTypes: true })
    files.push(...entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => join(ccHome, dir.name, entry.name)))
  }
  files.sort()

  const inputs: MaterializeInput[] = []
  const predictions: SessionPrediction[] = []
  const warnings: string[] = []
  let lines = 0
  let dropped = 0
  for (const file of files) {
    const session = await parseCcSession(file)
    const mapped = mapCcSession(session)
    lines += session.counts.lines
    dropped += session.counts.dropped
    warnings.push(...mapped.warnings.map(note => `${session.sessionUuid}: ${note}`))
    predictions.push(predictSession(session, mapped.events))
    if (mapped.events.length > 0) {
      inputs.push({
        id: ccSessionId(session.sessionUuid),
        cwd: session.cwd,
        createdAt: session.createdAt,
        events: mapped.events,
      })
    }
  }
  predictions.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  const summary = summarizePredictions(predictions)
  console.log('=== CC → dsh 导入 ===')
  console.log(`项目目录 ${dirs.length},转录文件 ${files.length}(子代理目录自动跳过)`)
  console.log(`解析:行 ${lines},丢弃 ${dropped},可物化会话 ${inputs.length}/${files.length}`)
  console.log(`预测:plan 出生 ${summary.planBirths} / todo 出生 ${summary.todoBirths} / 待总结 ${summary.summaryQueue} / 不出生 ${summary.noBirth}`)
  for (const { id, prediction, humanPrompts, events } of predictions) {
    const when = prediction.tier === 'summary' ? ` (人类发言 ${prediction.humanLines})` : ''
    const birth = 'willBirth' in prediction ? (prediction.willBirth ? '★' : '·') : '○'
    console.log(`  ${birth} ${id} 人话 ${humanPrompts} 事件 ${events}  [${prediction.tier}]${when} ${prediction.reason}`)
  }
  if (warnings.length > 0) {
    console.log(`映射警告 ${warnings.length} 条,前 10 条:`)
    for (const warning of warnings.slice(0, 10)) console.log(`  - ${warning}`)
  }

  if (args.values['dry-run']) {
    console.log('dry-run:未写入任何内容。去掉 --dry-run 执行物化。')
    return
  }

  if (args.values['wipe-ledger']) {
    console.log(`清账:abandon 非 done 任务 + ignore 待定候选 + 归档空项目 (${args.values['ledger-root']})`)
    const wiped = await wipeLedger(args.values['ledger-root']!)
    console.log(`  任务 abandon ${wiped.tasksAbandoned}(保留 done ${wiped.tasksKeptDone},已归档 ${wiped.tasksAlreadyArchived})`)
    console.log(`  候选 ignore ${wiped.candidatesIgnored}(终态保留 ${wiped.candidatesTerminal}),空项目归档 ${wiped.projectsArchived}`)
    if (wiped.rejected.length > 0) {
      console.log(`  被拒 ${wiped.rejected.length} 条,前 10 条:`)
      for (const line of wiped.rejected.slice(0, 10)) console.log(`    - ${line}`)
    }
  }

  const report = await materializeSessions(inputs, {
    root: args.values['sessions-root']!,
    compression,
  })
  console.log(`物化:新建 ${report.created.length},跳过 ${report.skipped.length}(${args.values['sessions-root']},compression=${compression})`)

  const adopted = await adoptWorkspaces({
    sessionsRoot: args.values['sessions-root']!,
    storageRoot: args.values['ledger-root']!,
    fallbackDir: args.values['adopt-fallback']!,
    compression,
  })
  const fresh = adopted.workspaces.filter(item => item.created).length
  const attached = adopted.workspaces.reduce((sum, item) => sum + item.attached.length, 0)
  console.log(`工作区:确保 ${adopted.workspaces.length} 个(新建 ${fresh},复用 ${adopted.workspaces.length - fresh}),挂载会话 ${attached}`)
  for (const item of adopted.workspaces) {
    console.log(`  ${item.created ? '新建' : '复用'} ${item.title}(${item.path}) 挂载 ${item.attached.length}`)
  }
  if (adopted.remapped.length > 0) {
    console.log(`重映射:${adopted.remapped.length} 个无法解析的 cwd → ${args.values['adopt-fallback']}`)
    for (const item of adopted.remapped) console.log(`  - ${item.id.slice(0, 11)}: ${item.from}`)
  }
  if (adopted.skipped.length > 0) {
    console.log(`跳过 ${adopted.skipped.length} 个:`)
    for (const item of adopted.skipped.slice(0, 10)) console.log(`  - ${item.id.slice(0, 11)}: ${item.reason}`)
  }
  console.log('下一步:重启 dsh,task-source 的历史 sweep 会拾取这些会话;plan/todo 层立即出生,summary 层在空闲门后逐条判定。')
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
