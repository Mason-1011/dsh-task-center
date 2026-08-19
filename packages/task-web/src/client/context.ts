/**
 * Structural types for the client-side services this bundle consumes. The
 * bundle runs inside the dsh web client's cordis runtime; these describe just
 * the surface we call, so nothing beyond the react-family platform seeds is
 * ever required at runtime.
 * @module @task-center/task-web/client/context
 */

/** Face a slot occupant receives (plus whatever the owner injects). */
export interface SlotFace {
  readonly [key: string]: unknown
}

/** Registration of one component into one named slot. */
export interface SlotDefinition {
  /** Slot key being occupied (must match the inject key). */
  readonly name: string
  /** Occupant id, unique within the slot. */
  readonly id: string
  /** Ordering hint inside list slots; lower renders first. */
  readonly order?: number
  /** Human label where the shell shows one. */
  readonly label?: string
  /** Builds the component's props; receives the slot owner's face. */
  readonly inject: (owner: SlotFace) => SlotFace
}

/** The web client's slot tree service (`ctx.slots`). */
export interface SlotsService {
  /** Subscribe a producer to one slot key. */
  readonly inject: (key: string, register: () => unknown) => void
  /** Place one component into a slot; the registration is the occupant. */
  readonly register: (definition: SlotDefinition, Component: unknown) => unknown
}

/** Result envelope of the /api typert channel. */
export interface RpcEnvelope {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** The web client's connection service (`ctx.connection`). */
export interface ConnectionService {
  readonly rpc: {
    readonly call: (
      channel: string,
      method: string,
      payload: { readonly args: Readonly<Record<string, unknown>> },
    ) => Promise<RpcEnvelope>
  }
}

/**
 * The web client's sessions service (`ctx.sessions`) — narrowed to the one
 * jump surface this board consumes. The full contract brands `SessionId`; the
 * wire hands us plain JSON strings, and method-parameter bivariance lets the
 * real service satisfy this structural face.
 */
export interface SessionsService {
  /**
   * Select a session as current (the conversation view switches to it).
   * @param id - session id; must exist in the host's list.
   */
  open(id: string): void
}

/** The client-side plugin context: only what this bundle touches. */
export interface ClientContext {
  readonly slots: SlotsService
  readonly connection: ConnectionService
  readonly sessions: SessionsService
  readonly on: (event: string, listener: () => void) => void
}
