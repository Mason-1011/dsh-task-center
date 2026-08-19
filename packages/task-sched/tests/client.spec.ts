/**
 * Bundle smoke test: the built client (dist/client.js) hands itself to the
 * dsh ModuleLoader under the package id, its factory runs with only the
 * platform seeds on require (react family + the official UI primitives), and
 * its cordis plugin applies into exactly the two conversation slot
 * registrations (the session header action + the input dock row) with
 * function components; faces carry the connection service.
 * @module @task-center/task-sched/tests/client
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/client.js')

/** The ModuleLoader handoff this bundle must produce. */
interface Handoff {
  readonly id: string
  readonly factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Run the bundle against a stub window; return the captured handoff. */
async function loadBundle(): Promise<{ code: string; handoff: Handoff }> {
  const code = await readFile(bundlePath, 'utf8')
  const loads: Handoff[] = []
  const fakeWindow = { __ModuleLoader__: { load: (handoff: Handoff) => loads.push(handoff) } }
  new Function('window', code)(fakeWindow)
  expect(loads).toHaveLength(1)
  return { code, handoff: loads[0]! }
}

/** A require that answers only the platform seeds, as the loader would. */
function seedRequire(spec: string): unknown {
  if (spec === 'react' || spec === 'react/jsx-runtime' || spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: () => () => null })
  }
  throw new Error(`bundle required a non-seed module: ${spec}`)
}

describe('task-sched client bundle', () => {
  it('hands itself to the ModuleLoader under the package id, seeds only', async () => {
    const { code, handoff } = await loadBundle()
    expect(code.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(handoff.id).toBe('@task-center/task-sched')
    // Only platform seeds are required; the official UI primitives must come
    // from the shell's seed (the npm copy is unstyled — bundling it is a bug).
    const specs = new Set([...code.matchAll(/require\((["'])(.+?)\1\)/g)].map(match => match[2]))
    expect([...specs]).toContain('@deepseek-ai/dsh-client-ui-primitives')
    for (const spec of specs) {
      const known = spec === 'react' || spec === 'react/jsx-runtime' || spec === '@deepseek-ai/dsh-client-ui-primitives'
      expect(known, `unexpected require ${spec}`).toBe(true)
    }
    // Token-only styling: no hardcoded palette values.
    expect(code).not.toMatch(/#10141c|#161d29|#242c3a|#1a2230|#0d1118|#151b26/)
  })

  it('exports a slots+connection plugin applying into both session-page surfaces', async () => {
    const { handoff } = await loadBundle()
    const plugin = handoff.factory(seedRequire)
    expect(typeof plugin['apply']).toBe('function')
    expect(plugin['inject']).toEqual(['slots', 'connection'])

    const registrations: { key: string; definition: Record<string, unknown>; Component: unknown }[] = []
    const connection = { rpc: { call: async () => ({ ok: true, value: {} }) } }
    const ctx = {
      slots: {
        inject: (key: string, register: () => unknown) => { registrations.push({ key, ...register() as { definition: Record<string, unknown>; Component: unknown } }) },
        register: (definition: Record<string, unknown>, Component: unknown) => ({ definition, Component }),
      },
      connection,
      on: () => {},
    }
    ;(plugin['apply'] as (context: unknown) => void)(ctx)

    expect(registrations.map(entry => entry.key).sort())
      .toEqual(['conversation.input.dock', 'conversation.session.header.actions'])
    for (const entry of registrations) {
      expect(typeof entry.Component).toBe('function')
      expect(entry.definition['name']).toBe(entry.key)
      expect(entry.definition['id']).toBe('task-sched')
      // The face carries the live connection service; the surfaces read the
      // session id from the framework kit, not from the face.
      const face = (entry.definition['inject'] as (owner: unknown) => Record<string, unknown>)({})
      expect(face).toEqual({ connection })
    }
  })
})
