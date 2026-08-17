/**
 * Bundle smoke test: the built client (dist/client.js) hands itself to the
 * dsh ModuleLoader under the package id, its factory runs with only the
 * react-family platform seeds on require, and its cordis plugin applies into
 * exactly two slot registrations (sidebar footer button + shell overlay) with
 * function components and a connection face.
 * @module @task-center/task-web/tests/client
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

/** A require that answers only the react-family seeds, as the loader would. */
function seedRequire(spec: string): unknown {
  if (spec === 'react' || spec === 'react/jsx-runtime') {
    return new Proxy({}, { get: () => () => null })
  }
  throw new Error(`bundle required a non-seed module: ${spec}`)
}

describe('task-web client bundle', () => {
  it('hands itself to the ModuleLoader under the package id, seeds only', async () => {
    const { code, handoff } = await loadBundle()
    expect(code.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(handoff.id).toBe('@task-center/task-web')
    // Nothing outside the react family is ever required.
    const specs = new Set([...code.matchAll(/require\((["'])(.+?)\1\)/g)].map(match => match[2]))
    expect([...specs]).toEqual(expect.arrayContaining(['react']))
    for (const spec of specs) {
      expect(spec === 'react' || spec === 'react/jsx-runtime', `unexpected require ${spec}`).toBe(true)
    }
  })

  it('exports a slots+connection plugin applying into both surfaces', async () => {
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
      .toEqual(['shell.overlay', 'sidebar.footer.action'])
    for (const entry of registrations) {
      expect(typeof entry.Component).toBe('function')
      expect(entry.definition['name']).toBe(entry.key)
      // The face carries the live connection service; no `locale`, so no `t`.
      const face = (entry.definition['inject'] as (owner: unknown) => unknown)({})
      expect(face).toEqual({ connection })
    }
  })
})
