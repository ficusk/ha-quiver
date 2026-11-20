// Backend for the Home Assistant connector.
//
// - Reads: `entities`, `areas`, `connection`, `pairingStatus`.
// - Pairing: `startPairing` mints a code; the public `connect` route redeems
//   it through `redeemPairing` for a durable secret; `homeForSecret` backs
//   the bridge's authorize gate.
// - Ingest: the bridge's dispatch handlers call `ingest*`, `setConnection`,
//   `setEdgeRelayStatus` and `recordIngestPressure` as state streams in.
//   None of these are in the manifest, so only this app's own server code
//   can reach them.
// - Control: `callService` and `cameraSignal` send frames down this
//   channel's live connection.
// - `facadeGuide` writes the brief for building a custom UI on top of all
//   this.
//
// `entities` / `connection` / `registry` are channel-scoped (one home per
// channel). `pairings` / `homes` are quiver-scoped and keyed by code/secret,
// so the channel-less connect route and authorize gate can resolve them.

import {
  api,
  query,
  mutation,
  action,
  v,
  type ActionContext,
  type HandlerContext,
} from "@quiver/server";
import { buildFacadeBrief } from "./facadeBrief";
import {
  classifyStateChange,
  formatIncidentMessage,
  transitionIncident,
  type IngestIncident,
  type PressureReport,
} from "./ingestPolicy";

const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;

interface HassState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

function domainOf(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot === -1 ? entityId : entityId.slice(0, dot);
}

// Hex from the CSPRNG. Call only from actions (see Pairing below).
function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function upsertEntity(
  ctx: any,
  s: HassState,
  now: number,
  options: { suppressRedundant?: boolean } = {},
): Promise<boolean> {
  const existing = await ctx.db
    .query("entities")
    .withIndex("by_entity", (q: any) => q.eq("entityId", s.entity_id))
    .unique();
  if (
    existing &&
    options.suppressRedundant &&
    classifyStateChange(existing as any, s).kind === "suppress"
  ) {
    return false;
  }
  const row = {
    entityId: s.entity_id,
    domain: domainOf(s.entity_id),
    state: s.state,
    attributes: s.attributes ?? {},
    lastChanged: s.last_changed,
    lastUpdated: s.last_updated,
    updatedAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("entities", row);
  return true;
}

// ---- Dashboard reads -----------------------------------------------------

export const entities = query({
  args: {},
  handler: async (ctx): Promise<any[]> => {
    const rows = await ctx.db.query("entities").collect();
    const reg = await ctx.db.query("registry").first();
    const meta = ((reg as any)?.entityMeta ?? {}) as Record<string, any>;
    return rows
      .map((r: any) => {
        const m = meta[r.entityId] ?? {};
        return {
          entityId: r.entityId,
          domain: r.domain,
          state: r.state,
          attributes: r.attributes ?? {},
          lastChanged: r.lastChanged,
          lastUpdated: r.lastUpdated,
          areaId: typeof m.areaId === "string" ? m.areaId : null,
          hidden: m.hidden === true,
          category: typeof m.category === "string" ? m.category : null,
        };
      })
      .sort((a: any, b: any) => a.entityId.localeCompare(b.entityId));
  },
});

// The home's areas, name-sorted. Empty until the integration sends a registry
// frame (older integrations don't), so the dashboard falls back to grouping by
// domain when this is empty.
export const areas = query({
  args: {},
  handler: async (ctx): Promise<any[]> => {
    const reg = await ctx.db.query("registry").first();
    const list = (((reg as any)?.areas ?? []) as any[])
      .filter((a) => a && typeof a.areaId === "string")
      .map((a) => ({ areaId: a.areaId as string, name: String(a.name ?? a.areaId) }));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const connection = query({
  args: {},
  handler: async (ctx): Promise<any> => {
    const row = await ctx.db.query("connection").first();
    if (!row) return null;
    return {
      connected: row.connected,
      lastError: row.lastError,
      edgeRelayActive: row.edgeRelayActive,
      edgeRelayVersion: row.edgeRelayVersion,
      edgeRelayRevision: row.edgeRelayRevision,
      edgeRelayError: row.edgeRelayError,
      lastSeen: row.lastSeen,
    };
  },
});

export const pairingStatus = query({
  args: {},
  handler: async (ctx): Promise<{ paired: boolean }> => {
    const channelId = (ctx as any).channelId as string;
    const home = await ctx.db
      .query("homes")
      .withIndex("by_channel", (q: any) => q.eq("channelId", channelId))
      .first();
    return { paired: !!home };
  },
});

// Internal: the bridge's authorize gate resolves a secret to its channel.
export const homeForSecret = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }): Promise<{ channelId: string } | null> => {
    const home = await ctx.db
      .query("homes")
      .withIndex("by_secret", (q: any) => q.eq("secret", secret))
      .unique();
    return home ? { channelId: (home as any).channelId } : null;
  },
});

// ---- Pairing -------------------------------------------------------------
//
// Codes and secrets are minted in actions: Convex seeds randomness inside
// queries and mutations deterministically, and these are credentials.

// Shown on the channel's pairing screen. Returns the channel's live code if
// it has one, so reopening the screen never invalidates a link in flight.
export const startPairing = action({
  args: {},
  handler: async (rawCtx): Promise<{ otp: string; path: string }> => {
    const ctx = rawCtx as unknown as ActionContext;
    const { otp } = (await ctx.runMutation(api.backend.functions.claimPairingCode, {
      candidate: randomToken(12),
    })) as { otp: string };
    return { otp, path: `/ha/connect?otp=${otp}` };
  },
});

export const claimPairingCode = mutation({
  args: { candidate: v.string() },
  handler: async (ctx, { candidate }): Promise<{ otp: string }> => {
    const now = Date.now();
    const channelId = (ctx as any).channelId as string;
    const existing = await ctx.db
      .query("pairings")
      .withIndex("by_channel", (q: any) => q.eq("channelId", channelId))
      .first();
    if (existing && (existing as any).expiresAt > now) {
      return { otp: (existing as any).otp };
    }
    if (existing) await ctx.db.delete((existing as any)._id);
    await ctx.db.insert("pairings", {
      otp: candidate,
      channelId,
      expiresAt: now + PAIRING_TTL_MS,
    });
    return { otp: candidate };
  },
});

export const redeemPairing = mutation({
  args: { otp: v.string(), secret: v.string() },
  handler: async (ctx, { otp, secret }): Promise<boolean> => {
    const now = Date.now();
    const pairing = await ctx.db
      .query("pairings")
      .withIndex("by_otp", (q: any) => q.eq("otp", otp))
      .unique();
    if (!pairing || (pairing as any).expiresAt <= now) return false;
    const channelId = (pairing as any).channelId as string;
    await ctx.db.insert("homes", { secret, channelId, createdAt: now });
    await ctx.db.delete((pairing as any)._id);
    return true;
  },
});

// ---- Global settings (quiver-wide) --------------------------------------
//
// Backs the `global` Settings entrypoint, which mounts without a channel.
// These touch ONLY the quiver-scoped `homes` / `pairings` tables — reading a
// channel-scoped table (entities/connection/registry) from a global dispatch
// fails loudly. So the live per-channel status below is read with
// `queryAllInstances` (the cross-instance read meant for "where is this app
// installed" views) and treated as best-effort: if it's unavailable from a
// channel-less context the screen still lists what's paired.

interface HomeStatus {
  connected: boolean;
  lastError?: string;
  lastSeen?: number;
  entityCount: number;
}

export const listHomes = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    homes: Array<{
      channelId: string;
      createdAt: number;
      connected?: boolean;
      lastError?: string;
      lastSeen?: number;
      entityCount?: number;
    }>;
    pending: Array<{ channelId: string; expiresAt: number }>;
  }> => {
    const now = Date.now();
    const homeRows = await ctx.db.query("homes").collect();
    const pairingRows = await ctx.db.query("pairings").collect();

    // Best-effort live status, joined across every channel this app is
    // installed in. Guarded: if cross-instance reads aren't available from a
    // channel-less context we still return the pairing list.
    const status = new Map<string, HomeStatus>();
    try {
      const conns = await (ctx.db as any).queryAllInstances("connection");
      for (const c of conns as any[]) {
        status.set(c.channelId, {
          connected: !!c.connected,
          lastError: c.lastError,
          lastSeen: c.lastSeen,
          entityCount: 0,
        });
      }
      const ents = await (ctx.db as any).queryAllInstances("entities");
      for (const e of ents as any[]) {
        let s = status.get(e.channelId);
        if (!s) {
          s = { connected: false, entityCount: 0 };
          status.set(e.channelId, s);
        }
        s.entityCount += 1;
      }
    } catch {
      /* cross-instance reads unavailable here — fall back to list-only */
    }

    const homes = homeRows
      .map((h: any) => {
        const s = status.get(h.channelId);
        return {
          channelId: h.channelId as string,
          createdAt: h.createdAt as number,
          connected: s?.connected,
          lastError: s?.lastError,
          lastSeen: s?.lastSeen,
          entityCount: s?.entityCount,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    const pending = pairingRows
      .filter((p: any) => p.expiresAt > now)
      .map((p: any) => ({
        channelId: p.channelId as string,
        expiresAt: p.expiresAt as number,
      }))
      .sort((a, b) => a.expiresAt - b.expiresAt);

    return { homes, pending };
  },
});

// Revoke a channel's home. Deletes every `homes` row for the channel (one in
// the normal case), which drops the channel's dashboard back to its pairing
// screen and makes the home's next reconnect fail the authorize gate until it
// re-pairs. Quiver-scoped, so it runs fine from the channel-less global frame.
// `targetChannelId`, not `channelId`: the bridge owns the name `channelId`
// (auto-injected for channel calls, stripped from iframe args), so the channel
// we're unpairing has to ride a differently-named arg to survive the dispatch.
export const unpairHome = mutation({
  args: { targetChannelId: v.string() },
  handler: async (ctx, { targetChannelId }): Promise<{ removed: number }> => {
    const rows = await ctx.db
      .query("homes")
      .withIndex("by_channel", (q: any) => q.eq("channelId", targetChannelId))
      .collect();
    for (const row of rows as any[]) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

// ---- Bridge-driven cache writes -----------------------------------------

export const ingestSnapshot = mutation({
  args: { states: v.array(v.any()) },
  handler: async (ctx, { states }): Promise<void> => {
    const now = Date.now();
    const seen = new Set<string>();
    for (const s of states as HassState[]) {
      if (!s || typeof s.entity_id !== "string") continue;
      seen.add(s.entity_id);
      await upsertEntity(ctx, s, now);
    }
    const existing = await ctx.db.query("entities").collect();
    for (const row of existing as any[]) {
      if (!seen.has(row.entityId)) await ctx.db.delete(row._id);
    }
    await markConnected(ctx, now);
  },
});

// Replace this channel's registry projection wholesale. Areas/flags are
// normalized to camelCase here so the read path and UI never see HA's
// snake_case wire shape.
export const ingestRegistry = mutation({
  args: { areas: v.array(v.any()), entities: v.any() },
  handler: async (ctx, { areas, entities }): Promise<void> => {
    const now = Date.now();
    const normAreas = ((areas as any[]) ?? [])
      .filter((a) => a && typeof a.area_id === "string")
      .map((a) => ({
        areaId: a.area_id as string,
        name: typeof a.name === "string" && a.name ? a.name : (a.area_id as string),
        floorId: typeof a.floor_id === "string" ? a.floor_id : null,
      }));
    const meta: Record<string, { areaId: string | null; hidden: boolean; category: string | null }> = {};
    for (const [entityId, raw] of Object.entries((entities ?? {}) as Record<string, any>)) {
      if (!raw || typeof raw !== "object") continue;
      meta[entityId] = {
        areaId: typeof raw.area_id === "string" ? raw.area_id : null,
        hidden: raw.hidden === true,
        category: typeof raw.category === "string" ? raw.category : null,
      };
    }
    const existing = await ctx.db.query("registry").first();
    const row = { areas: normAreas, entityMeta: meta, updatedAt: now };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("registry", row);
  },
});

export const ingestStateChanged = mutation({
  args: { entityId: v.string(), newState: v.any() },
  handler: async (ctx, { entityId, newState }): Promise<void> => {
    const now = Date.now();
    if (!newState) {
      const existing = await ctx.db
        .query("entities")
        .withIndex("by_entity", (q: any) => q.eq("entityId", entityId))
        .unique();
      if (existing) await ctx.db.delete(existing._id);
    } else {
      const incoming = {
        ...(newState as HassState),
        // The dispatch-derived entity id is the routing authority. Keep a
        // malformed payload from writing a second entity under a different id.
        entity_id: entityId,
      };
      await upsertEntity(ctx, incoming, now, { suppressRedundant: true });
    }
  },
});

const pressureOffenderValidator = v.object({
  entityId: v.string(),
  suppressed: v.number(),
  changedAttributes: v.array(v.string()),
  minPosition: v.optional(v.number()),
  maxPosition: v.optional(v.number()),
});

// Private bridge target. The relay sends at most one aggregate per minute,
// never one counter write per suppressed frame. This mutation owns the
// durable incident transition and its app-authored channel messages, so an
// OCC retry cannot duplicate a notification.
export const recordIngestPressure = mutation({
  args: {
    active: v.boolean(),
    windowStartedAt: v.number(),
    windowEndedAt: v.number(),
    received: v.number(),
    admitted: v.number(),
    suppressed: v.number(),
    offenders: v.array(pressureOffenderValidator),
  },
  handler: async (rawCtx, rawReport): Promise<void> => {
    const ctx = rawCtx as unknown as HandlerContext;
    const report = rawReport as PressureReport;
    const existing = (await ctx.db
      .query("ingestIncidents")
      .first()) as (IngestIncident & { _id: any }) | null;
    const transition = transitionIncident(existing, report, Date.now());

    if (transition.next) {
      if (existing) await ctx.db.patch(existing._id, transition.next);
      else await ctx.db.insert("ingestIncidents", transition.next);
    } else if (existing) {
      await ctx.db.delete(existing._id);
    }

    if (transition.notice && transition.messageIncident) {
      ctx.platform.chat.send({
        body: formatIncidentMessage(
          transition.notice,
          transition.messageIncident,
        ),
      });
    }
  },
});

async function markConnected(ctx: any, now: number): Promise<void> {
  const existing = await ctx.db.query("connection").first();
  const row = { connected: true, lastError: undefined, lastSeen: now, updatedAt: now };
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("connection", row);
}

export const setConnection = mutation({
  args: { connected: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { connected, error }): Promise<void> => {
    const now = Date.now();
    const existing = await ctx.db.query("connection").first();
    const row = {
      connected,
      lastError: connected ? undefined : error,
      lastSeen: now,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("connection", row);
  },
});

export const setEdgeRelayStatus = mutation({
  args: {
    active: v.boolean(),
    version: v.optional(v.number()),
    revision: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { active, version, revision, error }): Promise<void> => {
    const now = Date.now();
    const existing = await ctx.db.query("connection").first();
    const status = {
      edgeRelayActive: active,
      edgeRelayVersion: version,
      edgeRelayRevision: revision,
      edgeRelayError: active ? undefined : error,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, status);
    } else {
      await ctx.db.insert("connection", {
        connected: true,
        lastError: undefined,
        lastSeen: now,
        ...status,
      });
    }
  },
});

// ---- External pairing route ---------------------------------------------

export const connect = action({
  args: { request: v.optional(v.any()) },
  handler: async (
    rawCtx,
    { request },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const ctx = rawCtx as unknown as ActionContext;
    const req = (request ?? {}) as {
      url?: string;
      query?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const json = (status: number, obj: unknown) => ({
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    });

    let otp = new URLSearchParams(req.query ?? "").get("otp") ?? "";
    if (!otp && req.body) {
      try {
        otp = (JSON.parse(req.body) as { otp?: string }).otp ?? "";
      } catch {
        /* not JSON */
      }
    }
    if (!otp) return json(400, { error: "missing pairing code" });

    const secret = randomToken(20);
    const redeemed = (await ctx.runMutation(api.backend.functions.redeemPairing, {
      otp,
      secret,
    })) as boolean;
    if (!redeemed) return json(400, { error: "invalid or expired pairing code" });

    const host = req.headers?.["host"] ?? "";
    let scheme = "wss";
    try {
      scheme = new URL(req.url ?? "").protocol === "http:" ? "ws" : "wss";
    } catch {
      /* default wss */
    }
    return json(200, { wsUrl: `${scheme}://${host}/ha/ws?secret=${secret}` });
  },
});

// ---- Control -------------------------------------------------------------

export const callService = action({
  args: { domain: v.string(), service: v.string(), data: v.optional(v.any()) },
  handler: async (
    rawCtx,
    { domain, service, data },
  ): Promise<{ ok: true }> => {
    const ctx = rawCtx as unknown as ActionContext;
    await ctx
      .bridge("ha")
      .to({ channelId: ctx.channelId })
      .send(JSON.stringify({ type: "call_service", domain, service, data: data ?? {} }));
    return { ok: true };
  },
});

// ---- Cameras -------------------------------------------------------------
//
// Live video is a WebRTC session between the viewer's browser and the
// camera's stream source; only the handshake rides the link. The viewer
// drives it with `cameraSignal`, Home Assistant's replies land in the
// `camera-sessions` Slate under the session id (written by the bridge's
// `cameraSignal` dispatch), and the viewer reads them from there:
// `useSlate("camera-sessions")` in this app's UI, `cameraSession` from
// anywhere else.

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface CameraSession {
  entityId: string;
  startedAt: number;
  /** HA's WebRTC client configuration: { configuration: RTCConfiguration, dataChannel?, getCandidatesUpfront }. */
  config?: Record<string, unknown>;
  answer?: string;
  /** Remote ICE candidates (RTCIceCandidateInit), keyed by arrival order. */
  candidates?: Record<string, Record<string, unknown>>;
  error?: { code: string; message: string };
}

export const cameraSignal = action({
  args: {
    entityId: v.string(),
    sessionId: v.string(),
    type: v.union(
      v.literal("start"),
      v.literal("offer"),
      v.literal("keepalive"),
      v.literal("close"),
    ),
    sdp: v.optional(v.string()),
  },
  handler: async (
    rawCtx,
    { entityId, sessionId, type, sdp },
  ): Promise<{ ok: true }> => {
    const ctx = rawCtx as unknown as ActionContext;
    if (!entityId.startsWith("camera.")) {
      throw new Error(`${entityId} is not a camera.`);
    }
    if (!SESSION_ID.test(sessionId)) {
      throw new Error("sessionId must be 8–64 letters, digits, '-' or '_'.");
    }
    if (type === "offer" && !sdp) throw new Error("An offer needs its sdp.");

    const sessions = ctx.slates.open<CameraSession>("camera-sessions");
    if (type === "start") {
      await sessions.set(sessionId, { entityId, startedAt: Date.now() });
    }
    try {
      await ctx
        .bridge("ha")
        .to({ channelId: ctx.channelId })
        .send(
          JSON.stringify({
            type: "webrtc",
            session_id: sessionId,
            entity_id: entityId,
            message: type === "offer" ? { type, sdp } : { type },
          }),
        );
    } catch (err) {
      if (type !== "close") {
        await sessions.delete(sessionId).catch(() => {});
        throw err;
      }
    }
    if (type === "close") await sessions.delete(sessionId).catch(() => {});
    return { ok: true };
  },
});

export const cameraSession = action({
  args: { sessionId: v.string() },
  handler: async (rawCtx, { sessionId }): Promise<CameraSession | null> => {
    const ctx = rawCtx as unknown as ActionContext;
    if (!SESSION_ID.test(sessionId)) return null;
    const value = await ctx.slates
      .open<CameraSession>("camera-sessions")
      .read(sessionId);
    return (value as CameraSession | undefined) ?? null;
  },
});

// ---- Building on top -----------------------------------------------------

// Tools a facade has no business calling: pairing, settings, and the public
// HTTP route. Everything else in the manifest is fair game.
const NOT_FOR_FACADES = new Set([
  "startPairing",
  "listHomes",
  "unpairHome",
  "connect",
  "facadeGuide",
]);

export const facadeGuide = action({
  args: { goal: v.optional(v.string()) },
  handler: async (rawCtx, { goal }): Promise<string> => {
    const ctx = rawCtx as unknown as ActionContext;
    const { details } = await ctx.platform.apps.toolDetails({
      appId: ctx.appId,
    });
    return buildFacadeBrief({
      appId: ctx.appId,
      displayName: "Home Assistant",
      tools: details.filter((t) => !NOT_FOR_FACADES.has(t.name)),
      goal,
    });
  },
});
