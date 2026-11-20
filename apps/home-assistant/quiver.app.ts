import type { AppManifest } from "@quiver/system";

// The Quiver side of the Home Assistant integration in custom_components/.
// The integration dials in over the `ha` bridge and holds the socket open,
// so the house needs no open ports and the quiver holds no HA token.
//
// Pairing: the channel shows a connect link with a one-time code; the
// integration POSTs it to `/ha/connect` for a durable per-channel secret
// and dials `/ha/ws` with it. The bridge's authorize gate binds each socket
// to its channel. One home per channel.
//
// Functions the bridge uses to write state (ingest*, setConnection, …) are
// deliberately absent: anything declared here is callable by every member
// of the channel and by agents.
const manifest: AppManifest = {
  displayName: "Home Assistant",
  summary:
    "Control your home — lights, climate, media, cameras — from a Quiver channel.",
  description:
    "Pair a Home Assistant install to a channel and it streams live entity state into a dashboard you can control. The integration dials out from the house, so there are no ports to open and no token to copy.",
  categories: ["home"],
  chat: { write: true },
  entrypoints: {
    channel: "src/app.tsx",
    // Pairing state lives in the quiver-scoped `homes` table, so the one
    // place to see every paired home and revoke one is above any channel.
    global: { module: "src/global.tsx", title: "Settings" },
    bridges: {
      ha: {
        description: "Holds the WebSocket a paired Home Assistant dials in on.",
        path: "/ha/ws",
      },
    },
  },
  // Camera handshakes in flight, keyed by session id. Written only by
  // actions; the dashboard subscribes.
  slates: {
    "camera-sessions": {},
  },
  queries: {
    entities: {
      summary: "Every Home Assistant entity in this channel's home, with live state.",
      description:
        "One row per entity, sorted by entityId. There is no per-domain query; filter client-side (e.g. `e.domain === \"light\"`). Reactive: rows update as the home reports changes, so read state here and never from a control call's return.\n\nEach row: { entityId (\"light.kitchen\"), domain (\"light\" | \"switch\" | \"climate\" | \"media_player\" | \"cover\" | \"lock\" | \"camera\" | \"sensor\" | \"event\" | …), state: string, attributes: object, areaId: string | null, hidden: boolean, category: \"config\" | \"diagnostic\" | null }. `state` and `attributes` are domain-specific, exactly as Home Assistant reports them: a light is \"on\"/\"off\"/\"unavailable\" with attributes.brightness (0–255 when on); a climate entity has attributes.temperature and current_temperature; a sensor's reading is `state` with attributes.unit_of_measurement; an event entity's `state` is the ISO time it last fired, with attributes.event_type. attributes.friendly_name is the label to show.",
    },
    areas: {
      summary: "The home's areas (rooms), for grouping entities.",
      description:
        "[{ areaId, name }], sorted by name. Join against each entity's `areaId`. Empty until the home sends its registry, so treat it as optional.",
    },
    connection: {
      summary: "Whether this channel's home is connected right now.",
      description:
        "{ connected: boolean, lastError?: string, lastSeen: number }, or null before the home has ever connected. While `connected` is false, control calls fail: show an offline hint and keep showing the last-known `entities`.",
    },
    pairingStatus: {
      summary: "Whether a home has been paired to this channel.",
      description:
        "{ paired: boolean }. When false, `entities` is empty and nothing can be controlled; tell the member to open the Home Assistant app in this channel to pair.",
    },
    listHomes: {
      summary: "Every home paired anywhere on this quiver, for the Settings screen.",
      exposure: "own-ui",
    },
  },
  mutations: {
    unpairHome: {
      summary: "Unpair the home in a channel so it can be paired again.",
      description:
        "args: { targetChannelId }. Deletes the channel's pairing; the channel drops back to its pairing screen and the home's next reconnect is refused.",
      exposure: "own-ui",
    },
  },
  actions: {
    startPairing: {
      summary: "Get the connect link that pairs a Home Assistant install with this channel.",
      description:
        "Returns { otp, path }. The connect link is the quiver's origin plus `path`, e.g. https://example.quiver.city/ha/connect?otp=…. Paste it into the Quiver integration's setup in Home Assistant (or submit it as `url` in that config flow). Single use, valid for a day; calling again returns the same link until it's used.",
    },
    connect: {
      summary: "Pairing endpoint the Home Assistant integration POSTs its code to.",
      description:
        "Serves POST /ha/connect for the integration. Not useful to call directly: it needs the raw HTTP request.",
      publicRoute: { method: "POST", absolutePath: "/ha/connect" },
    },
    callService: {
      summary: "Call a Home Assistant service: turn on a light, set a temperature, …",
      description:
        "args: { domain, service, data? }, exactly as Home Assistant's own service calls. Resolves once the call is on its way to the home, not when it has run, so watch `entities` for the result; it updates a beat later. Throws when the home isn't connected (check `connection`).\n\nExamples: light turn_on { entity_id, brightness_pct: 0–100 }; light/switch toggle { entity_id }; climate set_temperature { entity_id, temperature }; media_player media_play_pause { entity_id }; lock lock / unlock { entity_id }; cover open_cover / close_cover / stop_cover { entity_id }. `data` is passed to Home Assistant as-is.",
    },
    cameraSignal: {
      summary: "Start, negotiate, keep alive, or stop a live WebRTC view of a camera.",
      description:
        "args: { entityId: \"camera.…\", sessionId: 8–64 chars of [A-Za-z0-9_-] that you choose, type: \"start\" | \"offer\" | \"keepalive\" | \"close\", sdp?: string }. Video goes straight from the camera's stream source to your RTCPeerConnection; only the handshake goes through here.\n\n1. `start`. Home Assistant replies with `config` (read it with `cameraSession`): pass `config.configuration` to `new RTCPeerConnection`.\n2. Add a recvonly audio transceiver, then a recvonly video transceiver, then, if `config.dataChannel` is set, a data channel with that label. Keep that order: Nest rejects an offer whose m-lines aren't audio, video, application. Create the offer, set it as the local description, and wait for ICE gathering to finish (a few seconds at most). Send `offer` with the resulting `localDescription.sdp`. Candidates are never sent separately.\n3. Poll `cameraSession` until `answer` appears; set it as the remote description. Add each entry of `candidates` as it arrives. `error` means stop.\n4. Send `keepalive` every minute while watching; the home ends sessions that go three minutes without one. Send `close` when done.\n\nOnly cameras that support WebRTC in Home Assistant work: Nest cameras, and most others through Home Assistant's built-in go2rtc.",
    },
    cameraSession: {
      summary: "Read Home Assistant's side of a camera handshake started with cameraSignal.",
      description:
        "args: { sessionId }. Returns null for an unknown session, or { entityId, startedAt, config?, answer?, candidates?: { [seq]: RTCIceCandidateInit }, error?: { code, message } }. Poll it every few hundred milliseconds during the handshake.",
    },
    facadeGuide: {
      summary: "How to build a custom app or UI over this home. Returns a brief to follow.",
      description:
        "Call this before writing a Quiver app that reads or controls Home Assistant devices: a remote for a few lights, a doorbell panel, a themed dashboard. args: { goal?: what the member asked for }. Returns markdown: the app's shape, the rules that matter, and every tool with its schema.",
    },
  },
};

export default manifest;
