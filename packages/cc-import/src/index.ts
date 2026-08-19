/**
 * Claude Code transcript → dsh session materializer: parse CC `.jsonl`
 * transcripts, map them to dsh `SessionEvent[]` logs, and write them as REAL
 * sessions under the sessions root — so the task-source extraction layer's own
 * sweep and judgment gates birth task candidates from them. This package does
 * format translation only; every task-level decision belongs to the extractor.
 * @module @task-center/cc-import
 */

export { parseCcSession } from './parse.ts'
export type { CcOp, CcSession, CcToolUseOp, CcUsage } from './parse.ts'
export { mapCcSession, CC_TODO_TOOL, CC_PLAN_TOOL } from './map.ts'
export type { MappedSession } from './map.ts'
export { materializeSessions, ccSessionId } from './materialize.ts'
export type { MaterializeInput, MaterializeOptions, MaterializeReport } from './materialize.ts'
export { predictSession, predictTier, summarizePredictions } from './predict.ts'
export type { SessionPrediction, TierPrediction, PredictSummary } from './predict.ts'
export { wipeLedger } from './wipe.ts'
export type { WipeReport } from './wipe.ts'
export { adoptWorkspaces } from './adopt.ts'
export type { AdoptOptions, AdoptReport, WorkspaceAdoption } from './adopt.ts'
