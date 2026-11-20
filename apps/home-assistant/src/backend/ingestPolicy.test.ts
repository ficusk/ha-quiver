import { describe, expect, test } from "bun:test";
import {
  PRESSURE_REMINDER_MS,
  classifyStateChange,
  formatIncidentMessage,
  transitionIncident,
  type ComparableState,
  type PressureReport,
} from "./ingestPolicy";

function media(position: number, updatedAt: string, state = "paused") {
  return {
    entity_id: "media_player.living_room_tv",
    state,
    attributes: {
      friendly_name: "Living Room TV",
      media_title: "New Tricks",
      media_position: position,
      media_position_updated_at: updatedAt,
    },
    last_updated: updatedAt,
  };
}

function stored(position: number, updatedAt: string, state = "paused"):
  ComparableState {
  const value = media(position, updatedAt, state);
  return {
    entityId: value.entity_id,
    state: value.state,
    attributes: value.attributes,
    lastUpdated: value.last_updated,
  };
}

describe("classifyStateChange", () => {
  test("suppresses the captured paused media-position jitter", () => {
    const decision = classifyStateChange(
      stored(0.004, "2026-08-22T12:00:00Z"),
      media(0.012, "2026-08-22T12:00:01Z"),
    );
    expect(decision).toEqual({
      kind: "suppress",
      reason: "media-position-deadband",
      changedAttributes: [
        "media_position",
        "media_position_updated_at",
      ],
      position: 0.012,
    });
  });

  test("suppresses timestamp-only duplicates", () => {
    const previous = stored(4, "2026-08-22T12:00:00Z");
    const incoming = media(4, "2026-08-22T12:00:01Z");
    expect(classifyStateChange(previous, incoming).kind).toBe("suppress");
  });

  test("admits a seek and every state transition", () => {
    expect(
      classifyStateChange(
        stored(0.004, "2026-08-22T12:00:00Z"),
        media(83.2, "2026-08-22T12:00:01Z"),
      ).kind,
    ).toBe("apply");
    expect(
      classifyStateChange(
        stored(83.2, "2026-08-22T12:00:01Z"),
        media(83.2, "2026-08-22T12:00:02Z", "playing"),
      ).kind,
    ).toBe("apply");
  });

  test("samples playing progress only after ten seconds", () => {
    expect(
      classifyStateChange(
        stored(100, "2026-08-22T12:00:00Z", "playing"),
        media(109.9, "2026-08-22T12:00:10Z", "playing"),
      ).kind,
    ).toBe("suppress");
    expect(
      classifyStateChange(
        stored(100, "2026-08-22T12:00:00Z", "playing"),
        media(110, "2026-08-22T12:00:10Z", "playing"),
      ).kind,
    ).toBe("apply");
  });

  test("admits another media attribute change immediately", () => {
    const incoming = media(0.008, "2026-08-22T12:00:01Z");
    incoming.attributes.media_title = "A different episode";
    expect(
      classifyStateChange(
        stored(0.004, "2026-08-22T12:00:00Z"),
        incoming,
      ).kind,
    ).toBe("apply");
  });
});

function report(start: number, end: number, active = true): PressureReport {
  return {
    active,
    windowStartedAt: start,
    windowEndedAt: end,
    received: 60,
    admitted: 0,
    suppressed: 60,
    offenders: [
      {
        entityId: "media_player.living_room_tv",
        suppressed: 60,
        changedAttributes: [
          "media_position",
          "media_position_updated_at",
        ],
        minPosition: 0.002,
        maxPosition: 0.012,
      },
    ],
  };
}

describe("pressure incident notifications", () => {
  test("starts immediately, reminds after ten minutes, and reports recovery", () => {
    const started = transitionIncident(null, report(0, 60_000), 60_000);
    expect(started.notice).toBe("started");
    expect(started.next?.suppressed).toBe(60);

    const quietReminder = transitionIncident(
      started.next,
      report(60_000, 120_000),
      120_000,
    );
    expect(quietReminder.notice).toBeNull();

    const reminder = transitionIncident(
      quietReminder.next,
      report(120_000, 11 * 60_000),
      60_000 + PRESSURE_REMINDER_MS,
    );
    expect(reminder.notice).toBe("reminder");
    expect(reminder.next?.suppressed).toBe(180);

    const recovered = transitionIncident(
      reminder.next,
      {
        ...report(11 * 60_000, 12 * 60_000, false),
        received: 1,
        admitted: 1,
        suppressed: 0,
        offenders: [],
      },
      12 * 60_000,
    );
    expect(recovered.notice).toBe("recovered");
    expect(recovered.next).toBeNull();
    expect(
      formatIncidentMessage("recovered", recovered.messageIncident!),
    ).toContain("returned to normal");
  });

  test("produces an actionable offender report", () => {
    const transition = transitionIncident(null, report(0, 60_000), 60_000);
    const message = formatIncidentMessage(
      transition.notice!,
      transition.messageIncident!,
    );
    expect(message).toContain("media_player.living_room_tv");
    expect(message).toContain("media_position_updated_at");
    expect(message).toContain("0.002–0.012 seconds");
    expect(message).toContain("60 per minute");
  });
});
