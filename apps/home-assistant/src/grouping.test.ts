import { describe, expect, test } from "bun:test";
import {
  buildGroups,
  isOn,
  type Area,
  type Entity,
} from "./grouping";

function e(partial: Partial<Entity> & { entityId: string }): Entity {
  const domain = partial.entityId.split(".")[0];
  return {
    domain,
    state: "off",
    attributes: {},
    ...partial,
  };
}

describe("buildGroups — domain fallback (no registry)", () => {
  const entities: Entity[] = [
    e({ entityId: "light.kitchen", state: "on" }),
    e({ entityId: "switch.porch" }),
    e({ entityId: "sensor.temp", state: "21.5", attributes: { unit_of_measurement: "°C" } }),
    e({ entityId: "binary_sensor.door", state: "on" }),
    e({ entityId: "automation.morning" }), // not a panel domain → dropped
    e({ entityId: "zone.home" }), // dropped
  ];

  test("groups by domain and drops non-panel domains", () => {
    const { mode, groups } = buildGroups(entities, []);
    expect(mode).toBe("domain");
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Lights", "Switches", "Sensors"]);
    // automation/zone never appear
    const allIds = groups.flatMap((g) => [...g.controls, ...g.readouts]).map((x) => x.entityId);
    expect(allIds).not.toContain("automation.morning");
    expect(allIds).not.toContain("zone.home");
  });

  test("buttons (Picos) and remotes are displayed as controls, not dropped", () => {
    const ents: Entity[] = [
      e({ entityId: "button.kitchen_pico_on", state: "unknown" }),
      e({ entityId: "remote.harmony", state: "on" }),
    ];
    const { groups } = buildGroups(ents, []);
    expect(groups.map((g) => g.label)).toEqual(["Remotes", "Buttons"]);
    const controls = groups.flatMap((g) => g.controls).map((x) => x.entityId);
    expect(controls.sort()).toEqual(["button.kitchen_pico_on", "remote.harmony"]);
  });

  test("device number/select entities are displayed as controls, not dropped", () => {
    const ents: Entity[] = [
      e({ entityId: "number.joule_target_temp", state: "54" }),
      e({ entityId: "select.joule_unit", state: "C", attributes: { options: ["C", "F"] } }),
      e({ entityId: "update.firmware" }), // still not a panel domain → dropped
    ];
    const { groups } = buildGroups(ents, []);
    const controls = groups.flatMap((g) => g.controls).map((x) => x.entityId).sort();
    expect(controls).toEqual(["number.joule_target_temp", "select.joule_unit"]);
    const allIds = groups.flatMap((g) => [...g.controls, ...g.readouts]).map((x) => x.entityId);
    expect(allIds).not.toContain("update.firmware");
  });

  test("sensors and binary_sensors land in readouts, not controls", () => {
    const { groups } = buildGroups(entities, []);
    const sensors = groups.find((g) => g.label === "Sensors")!;
    expect(sensors.controls).toHaveLength(0);
    expect(sensors.readouts.map((x) => x.entityId).sort()).toEqual([
      "binary_sensor.door",
      "sensor.temp",
    ]);
  });
});

describe("buildGroups — area mode", () => {
  const areas: Area[] = [
    { areaId: "kitchen", name: "Kitchen" },
    { areaId: "living", name: "Living Room" },
  ];
  const entities: Entity[] = [
    e({ entityId: "light.kitchen", state: "on", areaId: "kitchen" }),
    e({ entityId: "switch.kettle", state: "on", areaId: "kitchen" }),
    e({ entityId: "sensor.kitchen_temp", state: "20", areaId: "kitchen" }),
    e({ entityId: "light.lamp", areaId: "living" }),
    e({ entityId: "media_player.tv", state: "playing", areaId: "living" }),
    e({ entityId: "light.orphan", state: "on", areaId: "garage" }), // area not in list
    e({ entityId: "sensor.floating", state: "5", areaId: null }), // unassigned
    e({ entityId: "sensor.rssi", state: "-60", areaId: "kitchen", category: "diagnostic" }),
    e({ entityId: "light.secret", state: "on", areaId: "kitchen", hidden: true }),
  ];

  test("switches to area mode and orders known areas first, then orphan, unassigned, diagnostics", () => {
    const { mode, groups } = buildGroups(entities, areas);
    expect(mode).toBe("area");
    expect(groups.map((g) => g.label)).toEqual([
      "Kitchen",
      "Living Room",
      "garage", // orphan area: registry didn't list it, so show its raw id
      "Unassigned",
      "Diagnostics",
    ]);
  });

  test("hidden entities are dropped entirely", () => {
    const { groups } = buildGroups(entities, areas);
    const allIds = groups.flatMap((g) => [...g.controls, ...g.readouts]).map((x) => x.entityId);
    expect(allIds).not.toContain("light.secret");
  });

  test("diagnostics are pulled out of their area into the drawer", () => {
    const { groups } = buildGroups(entities, areas);
    const kitchen = groups.find((g) => g.label === "Kitchen")!;
    expect(kitchen.readouts.map((x) => x.entityId)).not.toContain("sensor.rssi");
    const diag = groups.find((g) => g.kind === "diagnostics")!;
    expect(diag.readouts.map((x) => x.entityId)).toContain("sensor.rssi");
  });

  test("within an area, controls precede readouts and on-state is derivable", () => {
    const { groups } = buildGroups(entities, areas);
    const kitchen = groups.find((g) => g.label === "Kitchen")!;
    expect(kitchen.controls.map((x) => x.entityId)).toEqual(["light.kitchen", "switch.kettle"]);
    expect(kitchen.readouts.map((x) => x.entityId)).toEqual(["sensor.kitchen_temp"]);
    expect(kitchen.controls.filter(isOn)).toHaveLength(2);
  });

  test("an entity with an unknown areaId but no area list still triggers area mode", () => {
    const onlyOrphan = [e({ entityId: "light.x", areaId: "somewhere" })];
    expect(buildGroups(onlyOrphan, []).mode).toBe("area");
  });
});
