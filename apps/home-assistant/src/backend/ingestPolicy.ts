export const MEDIA_POSITION_PLAYING_DEADBAND_SECONDS = 10;
export const MEDIA_POSITION_IDLE_DEADBAND_SECONDS = 1;
export const PRESSURE_REMINDER_MS = 10 * 60 * 1000;

const MEDIA_POSITION_ATTRIBUTES = new Set([
  "media_position",
  "media_position_updated_at",
]);

export interface ComparableState {
  entityId: string;
  state: string;
  attributes?: Record<string, unknown>;
  lastChanged?: string;
  lastUpdated?: string;
}

export interface IncomingState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export type StateChangeDecision =
  | { kind: "apply"; changedAttributes: string[] }
  | {
      kind: "suppress";
      reason: "duplicate" | "media-position-deadband";
      changedAttributes: string[];
      position?: number;
    };

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

function changedAttributeNames(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(incoming)])]
    .filter((key) => !jsonEqual(previous[key], incoming[key]))
    .sort();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Decide whether one HA state_changed frame changes the cache semantically.
 * HA's source timestamps are transport metadata, so they do not make an
 * otherwise-identical state material. Media position gets a state-aware
 * deadband: tiny paused jitter disappears, while a seek or periodic playing
 * progress still advances the cached full payload.
 */
export function classifyStateChange(
  previous: ComparableState | null,
  incoming: IncomingState,
): StateChangeDecision {
  if (!previous || previous.state !== incoming.state) {
    return { kind: "apply", changedAttributes: [] };
  }

  const previousAttributes = isRecord(previous.attributes)
    ? previous.attributes
    : {};
  const incomingAttributes = isRecord(incoming.attributes)
    ? incoming.attributes
    : {};
  const changedAttributes = changedAttributeNames(
    previousAttributes,
    incomingAttributes,
  );

  // last_changed / last_updated do not describe a new state on their own.
  if (changedAttributes.length === 0) {
    return {
      kind: "suppress",
      reason: "duplicate",
      changedAttributes:
        previous.lastUpdated !== incoming.last_updated
          ? ["last_updated"]
          : [],
    };
  }

  const isMediaPlayer = incoming.entity_id.startsWith("media_player.");
  const positionOnly = changedAttributes.every((name) =>
    MEDIA_POSITION_ATTRIBUTES.has(name),
  );
  if (isMediaPlayer && positionOnly) {
    const previousPosition = finiteNumber(
      previousAttributes.media_position,
    );
    const incomingPosition = finiteNumber(incomingAttributes.media_position);
    const positionTimestampOnly =
      changedAttributes.length === 1 &&
      changedAttributes[0] === "media_position_updated_at";
    const deadband =
      incoming.state === "playing"
        ? MEDIA_POSITION_PLAYING_DEADBAND_SECONDS
        : MEDIA_POSITION_IDLE_DEADBAND_SECONDS;
    if (
      positionTimestampOnly ||
      (previousPosition !== undefined &&
        incomingPosition !== undefined &&
        Math.abs(incomingPosition - previousPosition) < deadband)
    ) {
      return {
        kind: "suppress",
        reason: "media-position-deadband",
        changedAttributes,
        ...(incomingPosition === undefined
          ? {}
          : { position: incomingPosition }),
      };
    }
  }

  return { kind: "apply", changedAttributes };
}

export interface PressureOffenderReport {
  entityId: string;
  suppressed: number;
  changedAttributes: string[];
  minPosition?: number;
  maxPosition?: number;
}

export interface PressureReport {
  active: boolean;
  windowStartedAt: number;
  windowEndedAt: number;
  received: number;
  admitted: number;
  suppressed: number;
  offenders: PressureOffenderReport[];
}

export interface IncidentOffender {
  suppressed: number;
  changedAttributes: string[];
  minPosition?: number;
  maxPosition?: number;
}

export interface IngestIncident {
  startedAt: number;
  lastReportAt: number;
  lastNotifiedAt: number;
  received: number;
  admitted: number;
  suppressed: number;
  reports: number;
  offenders: Record<string, IncidentOffender>;
}

export type IncidentNotice = "started" | "reminder" | "recovered";

export interface IncidentTransition {
  next: IngestIncident | null;
  notice: IncidentNotice | null;
  messageIncident: IngestIncident | null;
}

function mergeOffenders(
  existing: Record<string, IncidentOffender>,
  reports: PressureOffenderReport[],
): Record<string, IncidentOffender> {
  const merged: Record<string, IncidentOffender> = { ...existing };
  for (const report of reports) {
    const previous = merged[report.entityId];
    merged[report.entityId] = {
      suppressed: (previous?.suppressed ?? 0) + report.suppressed,
      changedAttributes: [
        ...new Set([
          ...(previous?.changedAttributes ?? []),
          ...report.changedAttributes,
        ]),
      ].sort(),
      ...(previous?.minPosition === undefined &&
      report.minPosition === undefined
        ? {}
        : {
            minPosition: Math.min(
              previous?.minPosition ?? Number.POSITIVE_INFINITY,
              report.minPosition ?? Number.POSITIVE_INFINITY,
            ),
          }),
      ...(previous?.maxPosition === undefined &&
      report.maxPosition === undefined
        ? {}
        : {
            maxPosition: Math.max(
              previous?.maxPosition ?? Number.NEGATIVE_INFINITY,
              report.maxPosition ?? Number.NEGATIVE_INFINITY,
            ),
          }),
    };
  }
  return Object.fromEntries(
    Object.entries(merged)
      .sort((left, right) => right[1].suppressed - left[1].suppressed)
      .slice(0, 16),
  );
}

function mergeReport(
  existing: IngestIncident | null,
  report: PressureReport,
  now: number,
): IngestIncident {
  return {
    startedAt: existing?.startedAt ?? report.windowStartedAt,
    lastReportAt: report.windowEndedAt,
    lastNotifiedAt: existing?.lastNotifiedAt ?? now,
    received: (existing?.received ?? 0) + report.received,
    admitted: (existing?.admitted ?? 0) + report.admitted,
    suppressed: (existing?.suppressed ?? 0) + report.suppressed,
    reports: (existing?.reports ?? 0) + 1,
    offenders: mergeOffenders(existing?.offenders ?? {}, report.offenders),
  };
}

export function transitionIncident(
  existing: IngestIncident | null,
  report: PressureReport,
  now: number,
): IncidentTransition {
  if (!report.active) {
    if (!existing) return { next: null, notice: null, messageIncident: null };
    const completed = mergeReport(existing, report, now);
    return {
      next: null,
      notice: "recovered",
      messageIncident: completed,
    };
  }

  const next = mergeReport(existing, report, now);
  if (!existing) {
    next.lastNotifiedAt = now;
    return { next, notice: "started", messageIncident: next };
  }
  if (now - existing.lastNotifiedAt >= PRESSURE_REMINDER_MS) {
    next.lastNotifiedAt = now;
    return { next, notice: "reminder", messageIncident: next };
  }
  return { next, notice: null, messageIncident: null };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 2 * 60 * 1000) {
    return `${Math.max(1, Math.round(milliseconds / 1000))} seconds`;
  }
  return `${Math.max(2, Math.round(milliseconds / 60_000))} minutes`;
}

function positionRange(offender: IncidentOffender): string {
  if (
    offender.minPosition === undefined ||
    offender.maxPosition === undefined
  ) {
    return "";
  }
  return `; observed position ${offender.minPosition.toFixed(3)}–${offender.maxPosition.toFixed(3)} seconds`;
}

export function formatIncidentMessage(
  notice: IncidentNotice,
  incident: IngestIncident,
): string {
  const durationMs = Math.max(0, incident.lastReportAt - incident.startedAt);
  const duration = formatDuration(durationMs);
  const rate = Math.round(
    incident.suppressed / Math.max(durationMs / 60_000, 1 / 60),
  );
  const top = Object.entries(incident.offenders).sort(
    (left, right) => right[1].suppressed - left[1].suppressed,
  )[0];

  if (notice === "recovered") {
    return `Home Assistant update volume returned to normal after ${duration}. During the incident I suppressed ${incident.suppressed} redundant updates while continuing to apply controls and meaningful state changes.`;
  }

  const opening =
    notice === "started"
      ? "Home Assistant needs attention: I am receiving more entity updates than expected."
      : "Home Assistant still needs attention: the unusually frequent entity updates are continuing.";
  const source = top
    ? ` The main source is \`${top[0]}\`: ${top[1].suppressed} suppressed updates changing ${top[1].changedAttributes.map((name) => `\`${name}\``).join(", ") || "no meaningful fields"}${positionRange(top[1])}.`
    : "";
  return `${opening}${source} Since this started ${duration} ago, I received ${incident.received} updates and suppressed ${incident.suppressed} as redundant (about ${rate} per minute). I am limiting those updates; controls and meaningful state changes continue normally.`;
}
