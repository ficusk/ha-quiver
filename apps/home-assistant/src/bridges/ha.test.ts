import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";

function loadBridge(): any {
  const source = readFileSync(new URL("./ha.ts", import.meta.url), "utf8");
  let prepared = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  prepared = prepared.replace(
    /import\s+\{[^}]*\}\s+from\s+["']@quiver\/server["']\s*;?/,
    "const { api, defineBridge } = __quiverServer;",
  );
  prepared = prepared.replace(/export\s+default\s+/, "__exports.default = ");

  const apiStub = new Proxy(
    {},
    {
      get: () => apiStub,
    },
  );
  const context = {
    __quiverServer: {
      api: apiStub,
      defineBridge: () => (definition: unknown) => definition,
    },
    __exports: {} as { default?: unknown },
  };
  vm.createContext(context);
  vm.runInContext(prepared, context);
  return context.__exports.default;
}

function snapshot(position: number): string {
  return JSON.stringify({
    type: "snapshot",
    states: [
      {
        entity_id: "media_player.living_room_tv",
        state: "paused",
        attributes: {
          media_title: "Still watching",
          media_position: position,
          media_position_updated_at: "2026-08-22T20:00:00Z",
        },
      },
    ],
  });
}

function positionUpdate(position: number, title = "Still watching"): string {
  return JSON.stringify({
    type: "state_changed",
    state: {
      entity_id: "media_player.living_room_tv",
      state: "paused",
      attributes: {
        media_title: title,
        media_position: position,
        media_position_updated_at: "2026-08-22T20:00:01Z",
      },
    },
  });
}

describe("Home Assistant negotiated edge relay", () => {
  it("uses the same pure program at the HA edge and the Quiver backstop", () => {
    const bridge = loadBridge();
    const conn = { authorized: true };

    const initial = structuredClone(bridge.relay.initialState);
    const seeded = bridge.relay.onMessage(snapshot(0.002), initial, {}, conn);
    expect(seeded.dispatch[0].name).toBe("ingestSnapshot");

    const serverState = seeded.state;
    expect(
      bridge.relay.onMessage(positionUpdate(0.014), serverState, {}, conn),
    ).toBeUndefined();
    expect(
      bridge.relay.onMessage(
        positionUpdate(0.015, "A meaningful title"),
        serverState,
        {},
        conn,
      ).dispatch[0].name,
    ).toBe("ingestStateChanged");
  });

  it("sends executable source before authorization and that source suppresses jitter", async () => {
    const bridge = loadBridge();
    const lifecycle: string[] = [];
    let ready: any;
    const connection = {
      send: async (frame: string) => {
        lifecycle.push("send");
        ready = JSON.parse(frame);
      },
      authorize: async () => {
        lifecycle.push("authorize");
      },
      close: async () => {
        lifecycle.push("close");
      },
    };
    const ctx = {
      runQuery: async () => ({ channelId: "channel-1" }),
      bridge: () => ({ connection: () => connection }),
    };

    const accepted = bridge.relay.onAccept(
      {},
      structuredClone(bridge.relay.initialState),
      {
        id: "connection-1",
        query: { secret: "secret" },
      },
    );
    await bridge.dispatch.authorize(ctx, accepted.dispatch.payload);

    expect(lifecycle).toEqual(["send", "authorize"]);
    expect(ready.edge_relay).toMatchObject({
      language: "javascript",
      version: 1,
      revision: "ha-edge-relay-v2",
    });

    const edge = vm.runInNewContext(ready.edge_relay.source);
    let edgeState = structuredClone(edge.initialState);
    const seeded = edge.onMessage(snapshot(0.002), edgeState);
    edgeState = seeded.state;
    expect(seeded.send).toBe(snapshot(0.002));
    expect(edge.onMessage(positionUpdate(0.014), edgeState)).toBeUndefined();
    expect(
      edge.onMessage(
        positionUpdate(0.015, "A meaningful title"),
        edgeState,
      ).send,
    ).toEqual([positionUpdate(0.015, "A meaningful title")]);
  });

  it("reports aggregate pressure without forwarding suppressed source frames", async () => {
    const bridge = loadBridge();
    let ready: any;
    const ctx = {
      runQuery: async () => ({ channelId: "channel-1" }),
      bridge: () => ({
        connection: () => ({
          send: async (frame: string) => {
            ready = JSON.parse(frame);
          },
          authorize: async () => {},
          close: async () => {},
        }),
      }),
    };
    await bridge.dispatch.authorize(ctx, {
      ...bridge.relay.onAccept(
        {},
        structuredClone(bridge.relay.initialState),
        {
          id: "connection-1",
          query: { secret: "secret" },
        },
      ).dispatch.payload,
    });

    const edge = vm.runInNewContext(ready.edge_relay.source);
    let edgeState = structuredClone(edge.initialState);
    edgeState = edge.onMessage(snapshot(0.002), edgeState).state;
    for (let index = 0; index < 29; index += 1) {
      expect(edge.onMessage(positionUpdate(0.014), edgeState)).toBeUndefined();
    }
    const threshold = edge.onMessage(positionUpdate(0.014), edgeState);
    expect(threshold.send).toHaveLength(1);
    expect(JSON.parse(threshold.send[0])).toMatchObject({
      type: "ingest_pressure",
      report: {
        active: true,
        received: 30,
        admitted: 0,
        suppressed: 30,
        offenders: [
          {
            entityId: "media_player.living_room_tv",
            suppressed: 30,
          },
        ],
      },
    });
  });

  it("relays a camera handshake into the viewer's session", async () => {
    const bridge = loadBridge();
    const frame = (message: unknown, seq?: number) =>
      JSON.stringify({
        type: "webrtc",
        session_id: "session-1",
        entity_id: "camera.front_door",
        message,
        ...(seq === undefined ? {} : { seq }),
      });
    const authorized = { authorized: true };
    const dispatchOf = (raw: string) =>
      bridge.relay.onMessage(
        raw,
        structuredClone(bridge.relay.initialState),
        {},
        authorized,
      ).dispatch[0];

    const patches: Array<[string, unknown]> = [];
    const ctx = {
      runMutation: async (_fn: unknown, args: { sessionId: string; patch: unknown }) => {
        patches.push([args.sessionId, args.patch]);
      },
    };

    for (const raw of [
      frame({ type: "answer", answer: "v=0..." }),
      frame({ type: "candidate", candidate: { candidate: "a", sdpMid: "0" } }, 3),
      frame({ type: "error", code: "unavailable", message: "Camera is off" }),
      frame({ type: "session", session_id: "ignored" }),
    ]) {
      const step = dispatchOf(raw);
      expect(step.name).toBe("cameraSignal");
      await bridge.dispatch.cameraSignal(ctx, step.payload);
    }

    expect(patches).toEqual([
      ["session-1", { answer: "v=0..." }],
      ["session-1", { candidates: { "3": { candidate: "a", sdpMid: "0" } } }],
      ["session-1", { error: { code: "unavailable", message: "Camera is off" } }],
    ]);
  });
});
