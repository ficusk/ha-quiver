import { defineSchema, defineTable, v } from "@quiver/server";

// One row per Home Assistant entity. Channel-scoped: one home per channel,
// and the connection's relay binds each socket to its channel on authorize,
// so every state write lands in the right channel's cache.
const entities = defineTable({
  entityId: v.string(), // "light.kitchen"
  domain: v.string(), // "light"
  state: v.string(), // "on" / "off" / "23.5" / "playing" / ...
  attributes: v.any(), // friendly_name, brightness, supported_features, ...
  lastChanged: v.optional(v.string()),
  lastUpdated: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_entity", ["entityId"]);

// Connection status for this channel's home — one row per channel.
const connection = defineTable({
  connected: v.boolean(),
  lastError: v.optional(v.string()),
  edgeRelayActive: v.optional(v.boolean()),
  edgeRelayVersion: v.optional(v.number()),
  edgeRelayRevision: v.optional(v.string()),
  edgeRelayError: v.optional(v.string()),
  lastSeen: v.number(), // last connection lifecycle update
  updatedAt: v.number(),
});

// HA's area/device/entity registries, projected for this channel's home —
// one row per channel. Areas live outside the state machine, so they ride
// a separate frame and are stored apart from the entity cache; the
// `entities` read merges each entity's area/flags back in. `entityMeta`
// maps entityId → { areaId, hidden, category }.
const registry = defineTable({
  areas: v.array(v.any()), // [{ areaId, name, floorId }]
  entityMeta: v.any(),
  updatedAt: v.number(),
});

// One bounded, channel-local incident while the bridge is suppressing an
// unusual volume of redundant entity updates. Minute reports fold into this
// singleton; it never grows per frame. Row existence means the incident is
// active, and recovery deletes it after posting the closing channel message.
const ingestIncidents = defineTable({
  startedAt: v.number(),
  lastReportAt: v.number(),
  lastNotifiedAt: v.number(),
  received: v.number(),
  admitted: v.number(),
  suppressed: v.number(),
  reports: v.number(),
  offenders: v.any(),
});

// Pending pairing codes. Quiver-scoped because they're looked up by code
// (not channel) from the channel-less /ha/connect route. `channelId` is a
// plain column here (quiver scope reserves nothing), recording which
// channel the code was minted for. Single-use; swept after `expiresAt`.
const pairings = defineTable({
  otp: v.string(),
  channelId: v.string(),
  expiresAt: v.number(),
})
  .scope("quiver")
  .index("by_otp", ["otp"])
  .index("by_channel", ["channelId"]);

// Durable per-channel secrets the integration authenticates with. Quiver-scoped
// because the authorize gate resolves them by secret from a channel-less
// dispatch. Deleting a row revokes a home.
const homes = defineTable({
  secret: v.string(),
  channelId: v.string(),
  createdAt: v.number(),
})
  .scope("quiver")
  .index("by_secret", ["secret"])
  .index("by_channel", ["channelId"]);

export default defineSchema({
  entities,
  connection,
  registry,
  ingestIncidents,
  pairings,
  homes,
});
