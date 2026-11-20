// Bucketing entities into the panel's sections — pure, so it's unit-tested
// without a DOM. The dashboard shows controllable domains, cameras, sensors
// and events; everything else (automations, scenes, zones, …) is dropped as
// panel noise. When the home's areas are known it groups by room; until the
// integration sends a registry frame it falls back to grouping by domain.

export interface Entity {
  entityId: string;
  domain: string;
  state: string;
  attributes: Record<string, unknown>;
  lastChanged?: string;
  lastUpdated?: string;
  areaId?: string | null;
  hidden?: boolean;
  category?: string | null;
}

export interface Area {
  areaId: string;
  name: string;
}

// Controllable domains, in display order within a group.
export const CONTROL_ORDER = [
  "light",
  "switch",
  "input_boolean",
  "fan",
  "climate",
  "media_player",
  "cover",
  "lock",
  "camera",
  "remote",
  "button",
  "input_number",
  // Device-provided value controls. HA integrations expose setpoints (a sous
  // vide's target temp, an oven's timer) and modes as `number`/`select`, not
  // just the manual `input_*` helpers — without these, a device's primary
  // controls are cached but never drawn.
  "number",
  "select",
] as const;

const CONTROL_SET = new Set<string>(CONTROL_ORDER);
const CONTROL_RANK = new Map<string, number>(CONTROL_ORDER.map((d, i) => [d, i]));
const READ_DOMAINS = new Set(["sensor", "binary_sensor", "event"]);

// Section titles when there's no area data and we group by domain.
export const DOMAIN_LABEL: Record<string, string> = {
  light: "Lights",
  switch: "Switches",
  input_boolean: "Toggles",
  fan: "Fans",
  climate: "Climate",
  media_player: "Media",
  cover: "Covers",
  lock: "Locks",
  camera: "Cameras",
  remote: "Remotes",
  button: "Buttons",
  input_number: "Inputs",
  number: "Numbers",
  select: "Selectors",
};

export type GroupKind = "area" | "domain" | "unassigned" | "diagnostics";

export interface Group {
  key: string;
  label: string;
  kind: GroupKind;
  controls: Entity[]; // rendered with their controls
  readouts: Entity[]; // sensors and other read-only state
}

export interface Grouped {
  mode: "area" | "domain";
  groups: Group[];
}

export function name(e: Entity): string {
  const fn = e.attributes.friendly_name;
  return typeof fn === "string" && fn ? fn : e.entityId;
}

export function isOn(e: Entity): boolean {
  return e.state === "on" || e.state === "playing" || e.state === "open";
}

export function isControl(domain: string): boolean {
  return CONTROL_SET.has(domain);
}

// What earns a spot on the panel: things you operate, plus sensors.
function isDisplayed(e: Entity): boolean {
  return CONTROL_SET.has(e.domain) || READ_DOMAINS.has(e.domain);
}

// Config/diagnostic entities are real but rarely panel-worthy — tucked
// into a collapsed group at the bottom. Only known once a registry arrives.
function isDiagnostic(e: Entity): boolean {
  return e.category === "diagnostic" || e.category === "config";
}

function byName(a: Entity, b: Entity): number {
  return name(a).localeCompare(name(b));
}

function controlSort(a: Entity, b: Entity): number {
  const ra = CONTROL_RANK.get(a.domain) ?? 99;
  const rb = CONTROL_RANK.get(b.domain) ?? 99;
  return ra - rb || byName(a, b);
}

// Split a bucket of entities into controls (sorted by domain, then name)
// and read-only readouts (by name).
function partition(entities: Entity[]): { controls: Entity[]; readouts: Entity[] } {
  const controls: Entity[] = [];
  const readouts: Entity[] = [];
  for (const e of entities) {
    if (isControl(e.domain)) controls.push(e);
    else readouts.push(e);
  }
  controls.sort(controlSort);
  readouts.sort(byName);
  return { controls, readouts };
}

function makeGroup(key: string, label: string, kind: GroupKind, entities: Entity[]): Group {
  const { controls, readouts } = partition(entities);
  return { key, label, kind, controls, readouts };
}

export function buildGroups(entities: Entity[], areas: Area[]): Grouped {
  const shown = entities.filter((e) => !e.hidden && isDisplayed(e));
  const hasAreaData = areas.length > 0 || shown.some((e) => !!e.areaId);
  return hasAreaData
    ? { mode: "area", groups: areaGroups(shown, areas) }
    : { mode: "domain", groups: domainGroups(shown) };
}

function areaGroups(shown: Entity[], areas: Area[]): Group[] {
  const diagnostics = shown.filter(isDiagnostic);
  const main = shown.filter((e) => !isDiagnostic(e));

  const areaName = new Map(areas.map((a) => [a.areaId, a.name]));
  const buckets = new Map<string, Entity[]>();
  const UNASSIGNED = "\u0000unassigned"; // sorts away from real ids
  for (const e of main) {
    const k = e.areaId && areaName.has(e.areaId) ? e.areaId : e.areaId || UNASSIGNED;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(e);
  }

  const groups: Group[] = [];
  // Known areas first, in the order given (the query name-sorts them).
  for (const a of areas) {
    const bucket = buckets.get(a.areaId);
    if (bucket?.length) {
      groups.push(makeGroup(a.areaId, a.name, "area", bucket));
      buckets.delete(a.areaId);
    }
  }
  // Areas an entity references but the registry didn't list (orphans).
  const orphans = [...buckets.keys()]
    .filter((k) => k !== UNASSIGNED)
    .sort((x, y) => (areaName.get(x) ?? x).localeCompare(areaName.get(y) ?? y));
  for (const k of orphans) {
    groups.push(makeGroup(k, areaName.get(k) ?? k, "area", buckets.get(k)!));
  }
  // Then anything with no area, then the diagnostics drawer.
  const unassigned = buckets.get(UNASSIGNED);
  if (unassigned?.length) {
    groups.push(makeGroup(UNASSIGNED, "Unassigned", "unassigned", unassigned));
  }
  if (diagnostics.length) {
    groups.push(makeGroup("\u0000diagnostics", "Diagnostics", "diagnostics", diagnostics));
  }
  return groups;
}

function domainGroups(shown: Entity[]): Group[] {
  const byDomain = new Map<string, Entity[]>();
  for (const e of shown) {
    (byDomain.get(e.domain) ?? byDomain.set(e.domain, []).get(e.domain)!).push(e);
  }
  const groups: Group[] = [];
  for (const domain of CONTROL_ORDER) {
    const bucket = byDomain.get(domain);
    if (bucket?.length) {
      groups.push(makeGroup(domain, DOMAIN_LABEL[domain], "domain", bucket));
    }
  }
  const sensors = [
    ...(byDomain.get("sensor") ?? []),
    ...(byDomain.get("binary_sensor") ?? []),
    ...(byDomain.get("event") ?? []),
  ];
  if (sensors.length) {
    groups.push(makeGroup("\u0000sensors", "Sensors", "domain", sensors));
  }
  return groups;
}
