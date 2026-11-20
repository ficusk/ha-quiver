// Home Assistant bridge: one session per channel, one home per session.
//
// The integration dials in to `/ha/ws?secret=…`. The relay is pure and
// can't read the homes table, so it dispatches `authorize` with the
// connection id and secret; that action resolves the secret to a channel
// and binds the socket to that channel's session, or closes it. Once bound,
// the integration streams state and the relay dispatches it into the
// channel-scoped cache. Control goes back down through
// `ctx.bridge("ha").to({ channelId }).send(...)`.
//
// There's no top-level `url`: the quiver generally can't reach a home, so
// the home always dials in. Sending to a channel whose home is offline
// throws, and callers surface that as "not connected".
//
// Wire protocol (integration ↔ quiver), all JSON text frames:
//   up:   { type: "snapshot", states: [...] }            once, after `ready`
//         { type: "registry", areas, entities }          after `ready` + on change
//         { type: "state_changed", state: {...} }        per change
//         { type: "state_removed", entity_id: "..." }    entity gone
//         { type: "ingest_pressure", report: {...} }      edge aggregate
//         { type: "edge_relay_status", ... }              relay ack/error
//         { type: "webrtc", session_id, message, seq? }   camera handshake
//   down: { type: "ready", edge_relay: {...} }            authorize + relay
//         { type: "call_service", domain, service, data } control
//         { type: "webrtc", session_id, entity_id, message } camera handshake

import { api, defineBridge, type ActionContext } from "@quiver/server";

interface HassState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

interface AuthorizePayload {
  connectionId: string;
  secret: string;
  edgeRelaySource: string;
}
interface SnapshotPayload {
  states: HassState[];
}
interface RegistryPayload {
  areas: unknown[];
  entities: Record<string, unknown>;
}
interface StateChangedPayload {
  entityId: string;
  newState: HassState | null;
}
interface ConnectionPayload {
  connected: boolean;
  error?: string;
}

interface EdgeRelayStatusPayload {
  active: boolean;
  version?: number;
  revision?: string;
  error?: string;
}

interface CameraSignalPayload {
  sessionId: string;
  message: Record<string, unknown>;
  seq?: number;
}

interface PressureOffender {
  suppressed: number;
  changedAttributes: Record<string, true>;
  minPosition?: number;
  maxPosition?: number;
}

interface PressureWindow {
  startedAt: number;
  received: number;
  admitted: number;
  suppressed: number;
  offenders: Record<string, PressureOffender>;
}

interface RelayState {
  initialized: boolean;
  entities: Record<string, HassState>;
  window: PressureWindow;
  pressureActive: boolean;
  quietWindows: number;
}

interface PressureReportPayload {
  active: boolean;
  windowStartedAt: number;
  windowEndedAt: number;
  received: number;
  admitted: number;
  suppressed: number;
  offenders: Array<{
    entityId: string;
    suppressed: number;
    changedAttributes: string[];
    minPosition?: number;
    maxPosition?: number;
  }>;
}

interface EdgeRelayStep {
  state?: RelayState;
  send?: string | string[];
}

interface EdgeRelayProgram {
  initialState: RelayState;
  onMessage: (
    frame: string,
    state: RelayState,
  ) => EdgeRelayStep | undefined;
}

const EDGE_RELAY_VERSION = 1;
const EDGE_RELAY_REVISION = "ha-edge-relay-v2";

// This factory is deliberately self-contained. Quiver executes the returned
// pure relay as its defensive filter and sends the transpiled factory source
// to the HA companion, which runs the same program before network enqueue.
function createEdgeRelay(): EdgeRelayProgram {
  const PRESSURE_WINDOW_MS = 60 * 1000;
  const PRESSURE_START_COUNT = 30;
  const PRESSURE_CLEAR_COUNT = 5;
  const PRESSURE_CLEAR_WINDOWS = 2;
  const MAX_WINDOW_OFFENDERS = 16;
  const MEDIA_POSITION_ATTRIBUTES = [
    "media_position",
    "media_position_updated_at",
  ];

  function emptyWindow(now: number): PressureWindow {
    return {
      startedAt: now,
      received: 0,
      admitted: 0,
      suppressed: 0,
      offenders: {},
    };
  }

  function initialState(): RelayState {
    return {
      initialized: false,
      entities: {},
      window: emptyWindow(0),
      pressureActive: false,
      quietWindows: 0,
    };
  }

  function relayState(states: HassState[], now: number): RelayState {
    const entities: Record<string, HassState> = {};
    for (const state of states) {
      if (state && typeof state.entity_id === "string") {
        entities[state.entity_id] = state;
      }
    }
    return {
      initialized: true,
      entities,
      window: emptyWindow(now),
      pressureActive: false,
      quietWindows: 0,
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function jsonEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false;
      return (
        left.length === right.length &&
        left.every((value, index) => jsonEqual(value, right[index]))
      );
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonEqual(left[key], right[key]),
      )
    );
  }

  function changedAttributes(
    previous: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): string[] {
    const names: Record<string, true> = {};
    for (const name of Object.keys(previous)) names[name] = true;
    for (const name of Object.keys(incoming)) names[name] = true;
    return Object.keys(names)
      .filter((name) => !jsonEqual(previous[name], incoming[name]))
      .sort();
  }

  function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  function suppressibleChange(
    previous: HassState | undefined,
    incoming: HassState,
  ): { changedAttributes: string[]; position?: number } | null {
    if (!previous || previous.state !== incoming.state) return null;
    const before = isRecord(previous.attributes) ? previous.attributes : {};
    const after = isRecord(incoming.attributes) ? incoming.attributes : {};
    const changed = changedAttributes(before, after);
    if (changed.length === 0) {
      return {
        changedAttributes:
          previous.last_updated !== incoming.last_updated
            ? ["last_updated"]
            : [],
      };
    }
    if (
      !incoming.entity_id.startsWith("media_player.") ||
      !changed.every((name) => MEDIA_POSITION_ATTRIBUTES.includes(name))
    ) {
      return null;
    }
    const beforePosition = finiteNumber(before.media_position);
    const afterPosition = finiteNumber(after.media_position);
    const timestampOnly =
      changed.length === 1 && changed[0] === "media_position_updated_at";
    const deadband = incoming.state === "playing" ? 10 : 1;
    if (
      !timestampOnly &&
      (beforePosition === undefined ||
        afterPosition === undefined ||
        Math.abs(afterPosition - beforePosition) >= deadband)
    ) {
      return null;
    }
    return {
      changedAttributes: changed,
      ...(afterPosition === undefined ? {} : { position: afterPosition }),
    };
  }

  function noteSuppressed(
    window: PressureWindow,
    entityId: string,
    changed: string[],
    position?: number,
  ): void {
    let key = entityId;
    if (
      !window.offenders[key] &&
      Object.keys(window.offenders).length >= MAX_WINDOW_OFFENDERS
    ) {
      key = "other entities";
    }
    const offender = window.offenders[key] ?? {
      suppressed: 0,
      changedAttributes: {},
    };
    offender.suppressed += 1;
    for (const name of changed) offender.changedAttributes[name] = true;
    if (position !== undefined) {
      offender.minPosition = Math.min(
        offender.minPosition ?? position,
        position,
      );
      offender.maxPosition = Math.max(
        offender.maxPosition ?? position,
        position,
      );
    }
    window.offenders[key] = offender;
  }

  function pressureReport(
    window: PressureWindow,
    active: boolean,
    endedAt: number,
  ): PressureReportPayload {
    return {
      active,
      windowStartedAt: window.startedAt,
      windowEndedAt: endedAt,
      received: window.received,
      admitted: window.admitted,
      suppressed: window.suppressed,
      offenders: Object.entries(window.offenders)
        .map(([entityId, offender]) => ({
          entityId,
          suppressed: offender.suppressed,
          changedAttributes: Object.keys(offender.changedAttributes).sort(),
          ...(offender.minPosition === undefined
            ? {}
            : { minPosition: offender.minPosition }),
          ...(offender.maxPosition === undefined
            ? {}
            : { maxPosition: offender.maxPosition }),
        }))
        .sort((left, right) => right.suppressed - left.suppressed),
    };
  }

  function rollPressureWindow(
    state: RelayState,
    now: number,
  ): PressureReportPayload | null {
    if (now - state.window.startedAt < PRESSURE_WINDOW_MS) return null;
    const completed = state.window;
    state.window = emptyWindow(now);

    if (!state.pressureActive) {
      if (completed.suppressed < PRESSURE_START_COUNT) return null;
      state.pressureActive = true;
      state.quietWindows = 0;
      return pressureReport(completed, true, now);
    }

    if (completed.suppressed < PRESSURE_CLEAR_COUNT) {
      state.quietWindows += 1;
    } else {
      state.quietWindows = 0;
    }
    if (state.quietWindows >= PRESSURE_CLEAR_WINDOWS) {
      state.pressureActive = false;
      state.quietWindows = 0;
      return pressureReport(completed, false, now);
    }
    return pressureReport(completed, true, now);
  }

  function reportFrame(report: PressureReportPayload): string {
    return JSON.stringify({ type: "ingest_pressure", report });
  }

  return {
    initialState: initialState(),
    onMessage: (frame, state) => {
      let msg: any;
      try {
        msg = JSON.parse(frame);
      } catch {
        return undefined;
      }
      if (!msg || typeof msg !== "object") return undefined;

      switch (msg.type) {
        case "snapshot":
          return Array.isArray(msg.states)
            ? {
                state: relayState(msg.states, Date.now()),
                send: frame,
              }
            : undefined;
        case "registry":
        case "edge_relay_status":
        case "ingest_pressure":
        case "webrtc":
          return { send: frame };
        case "state_changed": {
          const incoming = msg.state;
          if (!incoming || typeof incoming.entity_id !== "string") {
            return undefined;
          }
          if (!state.initialized) {
            const nextState = relayState([incoming], Date.now());
            nextState.window.received = 1;
            nextState.window.admitted = 1;
            return { state: nextState, send: frame };
          }

          const now = Date.now();
          const sends: string[] = [];
          const rolled = rollPressureWindow(state, now);
          if (rolled) sends.push(reportFrame(rolled));
          state.window.received += 1;
          const suppressed = suppressibleChange(
            state.entities[incoming.entity_id],
            incoming,
          );
          if (suppressed) {
            state.window.suppressed += 1;
            noteSuppressed(
              state.window,
              incoming.entity_id,
              suppressed.changedAttributes,
              suppressed.position,
            );
            if (
              !state.pressureActive &&
              state.window.suppressed >= PRESSURE_START_COUNT
            ) {
              state.pressureActive = true;
              state.quietWindows = 0;
              sends.push(reportFrame(pressureReport(state.window, true, now)));
              state.window = emptyWindow(now);
            }
          } else {
            state.window.admitted += 1;
            state.entities[incoming.entity_id] = incoming;
            sends.push(frame);
          }
          return sends.length > 0 ? { send: sends } : undefined;
        }
        case "state_removed": {
          if (typeof msg.entity_id !== "string") return undefined;
          if (!state.initialized) {
            const nextState = relayState([], Date.now());
            nextState.window.received = 1;
            nextState.window.admitted = 1;
            return { state: nextState, send: frame };
          }

          const now = Date.now();
          const sends: string[] = [];
          const rolled = rollPressureWindow(state, now);
          if (rolled) sends.push(reportFrame(rolled));
          state.window.received += 1;
          state.window.admitted += 1;
          delete state.entities[msg.entity_id];
          sends.push(frame);
          return { send: sends };
        }
        default:
          return undefined;
      }
    },
  };
}

const EDGE_RELAY = createEdgeRelay();
const EDGE_RELAY_SOURCE = `(${createEdgeRelay.toString()})()`;

// Translate one handshake message from Home Assistant into a merge patch on
// the viewer's session. Candidates are keyed by sequence number so patches
// accumulate instead of replacing one another.
function cameraSessionPatch(
  payload: CameraSignalPayload,
): Record<string, unknown> | null {
  const m = payload.message;
  switch (m.type) {
    case "config":
      return m.config && typeof m.config === "object"
        ? { config: m.config }
        : null;
    case "answer":
      return typeof m.answer === "string" ? { answer: m.answer } : null;
    case "candidate":
      return m.candidate &&
        typeof m.candidate === "object" &&
        Number.isInteger(payload.seq)
        ? { candidates: { [String(payload.seq)]: m.candidate } }
        : null;
    case "error":
      return {
        error: {
          code: typeof m.code === "string" ? m.code.slice(0, 64) : "error",
          message:
            typeof m.message === "string" ? m.message.slice(0, 300) : "",
        },
      };
    default:
      return null;
  }
}

function pressurePayload(value: any): PressureReportPayload | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.active !== "boolean" ||
    !Number.isFinite(value.windowStartedAt) ||
    !Number.isFinite(value.windowEndedAt) ||
    !Number.isFinite(value.received) ||
    !Number.isFinite(value.admitted) ||
    !Number.isFinite(value.suppressed) ||
    !Array.isArray(value.offenders)
  ) {
    return null;
  }
  const offenders = value.offenders
    .filter(
      (offender: any) =>
        offender &&
        typeof offender === "object" &&
        typeof offender.entityId === "string" &&
        Number.isFinite(offender.suppressed) &&
        Array.isArray(offender.changedAttributes),
    )
    .slice(0, 16)
    .map((offender: any) => ({
      entityId: offender.entityId,
      suppressed: offender.suppressed,
      changedAttributes: offender.changedAttributes.filter(
        (name: unknown): name is string => typeof name === "string",
      ),
      ...(Number.isFinite(offender.minPosition)
        ? { minPosition: offender.minPosition }
        : {}),
      ...(Number.isFinite(offender.maxPosition)
        ? { maxPosition: offender.maxPosition }
        : {}),
    }));
  return {
    active: value.active,
    windowStartedAt: value.windowStartedAt,
    windowEndedAt: value.windowEndedAt,
    received: value.received,
    admitted: value.admitted,
    suppressed: value.suppressed,
    offenders,
  };
}

export default defineBridge<Record<string, string>, RelayState>()({
  relay: {
    initialState: EDGE_RELAY.initialState,
    // A fresh connection is anonymous. Hand its secret to the backend to
    // validate and bind; nothing else flows until it's authorized.
    onAccept: (_env, _state, conn) => ({
      dispatch: {
        name: "authorize",
        payload: {
          connectionId: conn.id,
          secret: conn.query.secret ?? "",
          // This source is produced in the supervisor's Bun-transpiled bridge
          // sandbox. Do not recompute Function.toString() in the Convex action
          // bundle: its optimizer may lift helpers out of the function body.
          edgeRelaySource: EDGE_RELAY_SOURCE,
        },
      },
    }),
    onMessage: (frame, state, _env, conn) => {
      if (!conn?.authorized) return undefined; // ignore until the gate binds us
      const edgeStep = EDGE_RELAY.onMessage(frame, state);
      if (!edgeStep) return undefined;

      const outgoing =
        edgeStep.send === undefined
          ? []
          : Array.isArray(edgeStep.send)
            ? edgeStep.send
            : [edgeStep.send];
      const dispatches: Array<{ name: string; payload: unknown }> = [];
      for (const outgoingFrame of outgoing) {
        let msg: any;
        try {
          msg = JSON.parse(outgoingFrame);
        } catch {
          continue;
        }
        if (!msg || typeof msg !== "object") continue;
        switch (msg.type) {
          case "snapshot":
            if (Array.isArray(msg.states)) {
              dispatches.push({
                name: "ingestSnapshot",
                payload: { states: msg.states },
              });
            }
            break;
          case "registry":
            dispatches.push({
              name: "ingestRegistry",
              payload: {
                areas: Array.isArray(msg.areas) ? msg.areas : [],
                entities:
                  msg.entities && typeof msg.entities === "object"
                    ? msg.entities
                    : {},
              },
            });
            break;
          case "state_changed":
            if (msg.state && typeof msg.state.entity_id === "string") {
              dispatches.push({
                name: "ingestStateChanged",
                payload: {
                  entityId: msg.state.entity_id,
                  newState: msg.state,
                },
              });
            }
            break;
          case "state_removed":
            if (typeof msg.entity_id === "string") {
              dispatches.push({
                name: "ingestStateChanged",
                payload: { entityId: msg.entity_id, newState: null },
              });
            }
            break;
          case "ingest_pressure": {
            const report = pressurePayload(msg.report);
            if (report) {
              dispatches.push({ name: "ingestPressureReport", payload: report });
            }
            break;
          }
          case "edge_relay_status":
            dispatches.push({
              name: "edgeRelayStatus",
              payload: {
                active: msg.active === true,
                ...(Number.isFinite(msg.version)
                  ? { version: msg.version }
                  : {}),
                ...(typeof msg.revision === "string"
                  ? { revision: msg.revision.slice(0, 120) }
                  : {}),
                ...(typeof msg.error === "string"
                  ? { error: msg.error.slice(0, 300) }
                  : {}),
              },
            });
            break;
          case "webrtc":
            if (
              typeof msg.session_id === "string" &&
              msg.message &&
              typeof msg.message === "object"
            ) {
              dispatches.push({
                name: "cameraSignal",
                payload: {
                  sessionId: msg.session_id,
                  message: msg.message,
                  ...(Number.isInteger(msg.seq) ? { seq: msg.seq } : {}),
                },
              });
            }
            break;
          default:
            break;
        }
      }

      // Ordinary frames mutate the in-memory state without returning a state
      // step, so they do not turn the durable bridgeState row into a hot row.
      return edgeStep.state || dispatches.length > 0
        ? {
            ...(edgeStep.state ? { state: edgeStep.state } : {}),
            ...(dispatches.length > 0 ? { dispatch: dispatches } : {}),
          }
        : undefined;
    },
    onClose: (_env, _state, conn) =>
      conn?.authorized
        ? { dispatch: { name: "connectionChanged", payload: { connected: false } } }
        : undefined,
  },
  dispatch: {
    // Runs channel-less (the connection isn't bound yet). Resolve the
    // secret, then ack + bind, or drop the socket. The dispatch starts with
    // authority over the unbound connection, so it must send the ack before
    // authorize moves that connection into the channel-scoped session.
    authorize: async (ctx: ActionContext, payload: AuthorizePayload) => {
      const home = payload.secret
        ? ((await ctx.runQuery(api.backend.functions.homeForSecret, {
            secret: payload.secret,
          })) as { channelId: string } | null)
        : null;
      const conn = ctx.bridge("ha").connection(payload.connectionId);
      if (home?.channelId) {
        await conn.send(
          JSON.stringify({
            type: "ready",
            edge_relay: {
              language: "javascript",
              version: EDGE_RELAY_VERSION,
              revision: EDGE_RELAY_REVISION,
              source: payload.edgeRelaySource,
            },
          }),
        );
        await conn.authorize({ channelId: home.channelId });
      } else {
        await conn.close();
      }
    },
    ingestSnapshot: async (ctx: ActionContext, payload: SnapshotPayload) => {
      await ctx.runMutation(api.backend.functions.ingestSnapshot, {
        states: payload.states,
      });
    },
    ingestRegistry: async (ctx: ActionContext, payload: RegistryPayload) => {
      await ctx.runMutation(api.backend.functions.ingestRegistry, {
        areas: payload.areas,
        entities: payload.entities,
      });
    },
    ingestStateChanged: async (
      ctx: ActionContext,
      payload: StateChangedPayload,
    ) => {
      await ctx.runMutation(api.backend.functions.ingestStateChanged, {
        entityId: payload.entityId,
        newState: payload.newState,
      });
    },
    ingestPressureReport: async (
      ctx: ActionContext,
      payload: PressureReportPayload,
    ) => {
      await ctx.runMutation(api.backend.functions.recordIngestPressure, payload);
    },
    edgeRelayStatus: async (
      ctx: ActionContext,
      payload: EdgeRelayStatusPayload,
    ) => {
      await ctx.runMutation(api.backend.functions.setEdgeRelayStatus, payload);
    },
    // The home's half of a camera handshake. The viewer started the session
    // (see the `cameraSignal` action), so its Slate key already exists; a
    // patch to a missing key means the viewer has gone and is dropped.
    cameraSignal: async (ctx: ActionContext, payload: CameraSignalPayload) => {
      const patch = cameraSessionPatch(payload);
      if (!patch) return;
      try {
        await ctx.slates.open("camera-sessions").patch(payload.sessionId, patch);
      } catch (err: any) {
        if (err?.code !== "missing_key") throw err;
      }
    },
    connectionChanged: async (ctx: ActionContext, payload: ConnectionPayload) => {
      await ctx.runMutation(api.backend.functions.setConnection, {
        connected: payload.connected,
        error: payload.error,
      });
    },
  },
});
