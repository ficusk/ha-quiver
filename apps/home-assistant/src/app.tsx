import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppContext, useQuery, useAction } from "@quiver/react";
import { CameraView } from "./camera";
import {
  buildGroups,
  isOn,
  name,
  type Area,
  type Entity,
  type Group,
} from "./grouping";
import { iconFor } from "./icons";

// ---- Types ---------------------------------------------------------------

interface Connection {
  connected: boolean;
  lastError?: string;
  edgeRelayActive?: boolean;
  edgeRelayVersion?: number;
  edgeRelayRevision?: string;
  edgeRelayError?: string;
  lastSeen: number;
}

// ---- Service-call plumbing -----------------------------------------------

type CallService = (
  domain: string,
  service: string,
  data?: Record<string, unknown>,
) => Promise<void>;

// Wraps the callService action, routing failures to the dashboard's error
// banner via the passed setter (a stable useState setter).
function useService(onError: (message: string | null) => void): CallService {
  const callService = useAction("callService");
  return useCallback(
    async (domain, service, data) => {
      try {
        await callService({ domain, service, data: data ?? {} });
        onError(null);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [callService, onError],
  );
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---- Controls ------------------------------------------------------------

function useBusyState() {
  const [pending, setPending] = useState(false);
  const run = useCallback(async (p: Promise<void>) => {
    setPending(true);
    try {
      await p;
    } catch {
      /* surfaced via the error banner */
    } finally {
      setPending(false);
    }
  }, []);
  return [pending, run] as const;
}

function ToggleControl({ e, call }: { e: Entity; call: CallService }) {
  const [pending, run] = useBusyState();
  const on = isOn(e);
  return (
    <button
      type="button"
      className="ha-toggle"
      disabled={pending}
      onClick={() => run(call(e.domain, "toggle", { entity_id: e.entityId }))}
      aria-pressed={on}
      aria-label={name(e)}
    >
      <span className="ha-knob" />
    </button>
  );
}

function LightControl({ e, call }: { e: Entity; call: CallService }) {
  const [, run] = useBusyState();
  const on = isOn(e);
  const modes = e.attributes.supported_color_modes;
  const dimmable =
    num(e.attributes.brightness) !== undefined ||
    (Array.isArray(modes) && modes.some((m) => m !== "onoff"));
  const brightness = num(e.attributes.brightness) ?? 0;
  const pct = on ? Math.round((brightness / 255) * 100) : 0;
  // While dragging we show an optimistic value; hand control back to the
  // real state once it catches up (within a rounding step), or after a
  // grace period if the change never lands. Clearing on pointerup alone
  // froze keyboard edits (no pointer event) and snapped the thumb back
  // before the round-trip.
  const [local, setLocal] = useState<number | null>(null);
  useEffect(() => {
    if (local === null) return;
    if (on && Math.abs(pct - local) <= 1) {
      setLocal(null);
      return;
    }
    const t = setTimeout(() => setLocal(null), 1500);
    return () => clearTimeout(t);
  }, [local, pct, on]);
  const commit = useDebounced((value: number) => {
    void run(
      call("light", "turn_on", { entity_id: e.entityId, brightness_pct: value }),
    );
  }, 200);
  const shown = local ?? pct;
  return (
    <>
      {dimmable && (
        <div className="ha-slider">
          <input
            type="range"
            min={0}
            max={100}
            value={shown}
            className="ha-range"
            onChange={(ev) => {
              const v = Number(ev.target.value);
              setLocal(v);
              commit(v);
            }}
            aria-label={`${name(e)} brightness`}
          />
          <span className="ha-pct ha-mono">{shown}%</span>
        </div>
      )}
      <ToggleControl e={e} call={call} />
    </>
  );
}

function StepperControl({
  e,
  call,
  service,
  field,
  value,
  min,
  max,
  step,
  unit,
}: {
  e: Entity;
  call: CallService;
  service: { domain: string; name: string };
  field: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  unit?: string;
}) {
  const [, run] = useBusyState();
  const set = (next: number) => {
    const clamped = Math.min(max ?? next, Math.max(min ?? next, next));
    const rounded = Math.round(clamped / step) * step;
    void run(
      call(service.domain, service.name, {
        entity_id: e.entityId,
        [field]: Number(rounded.toFixed(2)),
      }),
    );
  };
  return (
    <div className="ha-step">
      <button
        type="button"
        className="ha-stepbtn"
        onClick={() => set(value - step)}
        disabled={min !== undefined && value <= min}
        aria-label="decrease"
      >
        −
      </button>
      <span className="ha-stepval ha-mono">
        {value}
        {unit ? <span className="ha-unit">{unit}</span> : null}
      </span>
      <button
        type="button"
        className="ha-stepbtn"
        onClick={() => set(value + step)}
        disabled={max !== undefined && value >= max}
        aria-label="increase"
      >
        +
      </button>
    </div>
  );
}

function ClimateControl({ e, call }: { e: Entity; call: CallService }) {
  const target = num(e.attributes.temperature);
  const current = num(e.attributes.current_temperature);
  const step = num(e.attributes.target_temp_step) ?? 0.5;
  if (target === undefined) {
    return <span className="ha-val ha-mono">{e.state}</span>;
  }
  return (
    <>
      {current !== undefined && (
        <span className="ha-now ha-mono">{current}°</span>
      )}
      <StepperControl
        e={e}
        call={call}
        service={{ domain: "climate", name: "set_temperature" }}
        field="temperature"
        value={target}
        min={num(e.attributes.min_temp)}
        max={num(e.attributes.max_temp)}
        step={step}
        unit="°"
      />
    </>
  );
}

// Drives both the manual `input_number` helper and device-provided `number`
// entities (e.g. a sous vide's target temp). Same service shape — set_value
// with a `value` — so we route to the entity's own domain.
function NumberControl({ e, call }: { e: Entity; call: CallService }) {
  const value = num(e.attributes.value) ?? (Number(e.state) || 0);
  return (
    <StepperControl
      e={e}
      call={call}
      service={{ domain: e.domain, name: "set_value" }}
      field="value"
      value={value}
      min={num(e.attributes.min)}
      max={num(e.attributes.max)}
      step={num(e.attributes.step) ?? 1}
      unit={
        typeof e.attributes.unit_of_measurement === "string"
          ? ` ${e.attributes.unit_of_measurement}`
          : undefined
      }
    />
  );
}

// Device-provided `select` (and the `input_select` helper): a dropdown of
// `attributes.options`, current choice in `state`. select_option swaps it.
function SelectControl({ e, call }: { e: Entity; call: CallService }) {
  const [pending, run] = useBusyState();
  const options = Array.isArray(e.attributes.options)
    ? (e.attributes.options as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];
  const current = typeof e.state === "string" ? e.state : "";
  // If the live state isn't among the options (e.g. "unavailable"), keep it
  // selectable so the control doesn't silently misrepresent the device.
  const known = options.includes(current);
  return (
    <select
      className="ha-select"
      value={known ? current : ""}
      disabled={pending || options.length === 0}
      onChange={(ev) =>
        run(
          call(e.domain, "select_option", {
            entity_id: e.entityId,
            option: ev.target.value,
          }),
        )
      }
      aria-label={name(e)}
    >
      {!known && (
        <option value="" disabled>
          {current || "—"}
        </option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function MediaControl({ e, call }: { e: Entity; call: CallService }) {
  const [, run] = useBusyState();
  const title = e.attributes.media_title;
  return (
    <>
      {typeof title === "string" && title && (
        <span className="ha-sub">{title}</span>
      )}
      <button
        type="button"
        className="ha-icon"
        onClick={() =>
          run(call("media_player", "media_play_pause", { entity_id: e.entityId }))
        }
        aria-label="play/pause"
      >
        {e.state === "playing" ? "❚❚" : "▶"}
      </button>
    </>
  );
}

function PressControl({ e, call }: { e: Entity; call: CallService }) {
  const [pending, run] = useBusyState();
  return (
    <button
      type="button"
      className="ha-pill"
      disabled={pending}
      onClick={() => run(call("button", "press", { entity_id: e.entityId }))}
    >
      Press
    </button>
  );
}

function CoverControl({ e, call }: { e: Entity; call: CallService }) {
  const [, run] = useBusyState();
  return (
    <div className="ha-pills">
      <button type="button" className="ha-pill" onClick={() => run(call("cover", "open_cover", { entity_id: e.entityId }))}>Open</button>
      <button type="button" className="ha-pill" onClick={() => run(call("cover", "stop_cover", { entity_id: e.entityId }))}>Stop</button>
      <button type="button" className="ha-pill" onClick={() => run(call("cover", "close_cover", { entity_id: e.entityId }))}>Close</button>
    </div>
  );
}

function LockControl({ e, call }: { e: Entity; call: CallService }) {
  const [, run] = useBusyState();
  const locked = e.state === "locked";
  return (
    <button
      type="button"
      className={locked ? "ha-pill" : "ha-pill warn"}
      onClick={() =>
        run(call("lock", locked ? "unlock" : "lock", { entity_id: e.entityId }))
      }
    >
      {locked ? "Locked" : "Unlocked"}
    </button>
  );
}

function Control({ e, call }: { e: Entity; call: CallService }) {
  switch (e.domain) {
    case "light":
      return <LightControl e={e} call={call} />;
    case "switch":
    case "input_boolean":
    case "fan":
    case "remote":
      return <ToggleControl e={e} call={call} />;
    case "button":
      return <PressControl e={e} call={call} />;
    case "climate":
      return <ClimateControl e={e} call={call} />;
    case "input_number":
    case "number":
      return <NumberControl e={e} call={call} />;
    case "select":
    case "input_select":
      return <SelectControl e={e} call={call} />;
    case "media_player":
      return <MediaControl e={e} call={call} />;
    case "cover":
      return <CoverControl e={e} call={call} />;
    case "lock":
      return <LockControl e={e} call={call} />;
    default:
      return <span className="ha-val ha-mono">{e.state}</span>;
  }
}

function CameraRow({ e }: { e: Entity }) {
  const [watching, setWatching] = useState(false);
  const Icon = iconFor(e);
  const available = e.state !== "unavailable";
  return (
    <div className="ha-camrow" data-on={watching ? "true" : "false"}>
      <div className="ha-row">
        <Icon className="ha-ic" size={16} aria-hidden="true" />
        <span className="ha-name" title={e.entityId}>
          {name(e)}
        </span>
        <div className="ha-ctl">
          <button
            type="button"
            className="ha-pill"
            disabled={!available && !watching}
            onClick={() => setWatching((w) => !w)}
          >
            {watching ? "Stop" : available ? "Live" : "Unavailable"}
          </button>
        </div>
      </div>
      {watching && <CameraView entityId={e.entityId} />}
    </div>
  );
}

function Row({ e, call }: { e: Entity; call: CallService }) {
  if (e.domain === "camera") return <CameraRow e={e} />;
  const Icon = iconFor(e);
  return (
    <div className="ha-row" data-on={isOn(e) ? "true" : "false"}>
      <Icon className="ha-ic" size={16} aria-hidden="true" />
      <span className="ha-name" title={e.entityId}>
        {name(e)}
      </span>
      <div className="ha-ctl">
        <Control e={e} call={call} />
      </div>
    </div>
  );
}

function ReadRow({ e }: { e: Entity }) {
  const unit = e.attributes.unit_of_measurement;
  const Icon = iconFor(e);
  return (
    <div className="ha-row">
      <Icon className="ha-ic" size={16} aria-hidden="true" />
      <span className="ha-name" title={e.entityId}>
        {name(e)}
      </span>
      {e.domain === "event" ? (
        <span className="ha-val">{describeEvent(e)}</span>
      ) : (
        <span className="ha-val ha-mono">
          {e.state}
          {typeof unit === "string" ? <span className="ha-unit"> {unit}</span> : ""}
        </span>
      )}
    </div>
  );
}

// An event entity's state is the time it last fired ("doorbell rang 4m ago").
function describeEvent(e: Entity): string {
  const at = Date.parse(e.state);
  if (Number.isNaN(at)) return "—";
  const type = e.attributes.event_type;
  const label = typeof type === "string" ? type.replace(/_/g, " ") : "fired";
  return `${label} · ${ago(Date.now() - at)}`;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// ---- Cards ---------------------------------------------------------------

function GroupRows({ group, call }: { group: Group; call: CallService }) {
  return (
    <div className="ha-rows">
      {group.controls.map((e) => (
        <Row key={e.entityId} e={e} call={call} />
      ))}
      {group.readouts.map((e) => (
        <ReadRow key={e.entityId} e={e} />
      ))}
    </div>
  );
}

function AreaCard({ group, call }: { group: Group; call: CallService }) {
  const total = group.controls.length;
  const onCount = group.controls.filter(isOn).length;
  return (
    <section className="ha-card">
      <header className="ha-card-h">
        <span className="ha-area">{group.label}</span>
        <span className="ha-meta">
          {total > 0 ? (
            <>
              {total} · <b>{onCount} on</b>
            </>
          ) : (
            `${group.readouts.length} readings`
          )}
        </span>
      </header>
      <GroupRows group={group} call={call} />
    </section>
  );
}

function DiagnosticsDrawer({ group, call }: { group: Group; call: CallService }) {
  const count = group.controls.length + group.readouts.length;
  return (
    <details className="ha-diag">
      <summary>
        {group.label} · {count}
      </summary>
      <GroupRows group={group} call={call} />
    </details>
  );
}

// ---- Dashboard -----------------------------------------------------------

export default function App() {
  const context = useAppContext();
  const pairing = useQuery("pairingStatus", context ? {} : "skip") as
    | { paired: boolean }
    | undefined;
  return (
    <div className="ha">
      <style>{CSS}</style>
      {!context || pairing === undefined ? (
        <div className="ha-center">Connecting…</div>
      ) : pairing.paired ? (
        <Dashboard />
      ) : (
        <PairingScreen />
      )}
    </div>
  );
}

// my.home-assistant.io forwards to the member's own Home Assistant.
const ADD_INTEGRATION_URL =
  "https://my.home-assistant.io/redirect/config_flow_start/?domain=quiver";

function PairingScreen() {
  const context = useAppContext();
  const startPairing = useAction("startPairing");
  const [otp, setOtp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    startPairing({})
      .then((r: any) => {
        if (live) setOtp(r?.otp ?? null);
      })
      .catch(() => {
        /* surfaced as the loading state */
      });
    return () => {
      live = false;
    };
  }, [startPairing]);
  // The link names the quiver, whose origin the app's frame does not share.
  // A shell that sends no shellOrigin still loads the frame on the quiver's
  // origin, so the frame's own URL resolves the path there.
  const shellOrigin =
    context && "shellOrigin" in context && typeof context.shellOrigin === "string"
      ? context.shellOrigin
      : null;
  const url = otp
    ? new URL(`/ha/connect?otp=${otp}`, shellOrigin ?? window.location.href).href
    : "";
  return (
    <>
      <header className="ha-top">
        <div className="ha-brand">
          <span className="ha-led" />
          <h1 className="ha-title">Home Assistant</h1>
        </div>
      </header>
      <div className="ha-pair">
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Connect your home</h2>
        <p style={{ color: "var(--text-muted)", lineHeight: 1.5, margin: 0, fontSize: 13 }}>
          Install the Quiver integration in Home Assistant, then paste this link
          into its setup. Your home dials in — nothing to open at the house, no
          token to copy.
        </p>
        <ol style={{ color: "var(--text-muted)", lineHeight: 1.6, paddingLeft: 18, fontSize: 13 }}>
          <li>
            In Home Assistant, add the Quiver integration (
            <a href={ADD_INTEGRATION_URL} target="_blank" rel="noreferrer">
              open it there
            </a>
            , or Settings → Devices &amp; Services → Add integration).
          </li>
          <li>Paste the link below when it asks where to connect.</li>
        </ol>
        {url ? (
          <div className="ha-code">{url}</div>
        ) : (
          <div className="ha-center">Generating a code…</div>
        )}
        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "12px 0 0" }}>
          The code is single-use. This screen always shows a working one — reopen
          it any time, or it refreshes itself.
        </p>
      </div>
    </>
  );
}

function Dashboard() {
  const context = useAppContext();
  const entities = useQuery("entities", context ? {} : "skip") as
    | Entity[]
    | undefined;
  const areas = useQuery("areas", context ? {} : "skip") as Area[] | undefined;
  const connection = useQuery("connection", context ? {} : "skip") as
    | Connection
    | null
    | undefined;
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const call = useService(setError);

  const { groups } = useMemo(
    () => buildGroups(entities ?? [], areas ?? []),
    [entities, areas],
  );
  // The filter box only appears past a handful of entities; below that the
  // filter is ignored so a now-hidden box can't strand the dashboard on an
  // unclearable "no matches" state.
  const filterable = !!entities && entities.length > 8;
  const activeFilter = filterable ? filter : "";
  const shown = useMemo(
    () => filterGroups(groups, activeFilter),
    [groups, activeFilter],
  );

  return (
    <>
      <header className="ha-top">
        <div className="ha-brand">
          <StatusLed connection={connection} />
          <h1 className="ha-title">Home Assistant</h1>
        </div>
        <span className="ha-spacer" />
        {filterable && (
          <input
            className="ha-filter"
            type="search"
            placeholder="Filter…"
            value={filter}
            onChange={(ev) => setFilter(ev.target.value)}
            aria-label="Filter entities"
          />
        )}
      </header>

      {error && (
        <div className="ha-banner err" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {connection && !connection.connected && (
        <div className="ha-banner warn">
          {connection.lastError
            ? `Not connected — ${connection.lastError}.`
            : "Waiting for your home to reconnect…"}
        </div>
      )}

      {connection?.connected && connection.edgeRelayActive === false && (
        <div className="ha-banner warn">
          Home Assistant is connected, but source-side event filtering is not
          active
          {connection.edgeRelayError
            ? ` — ${connection.edgeRelayError}.`
            : "."}{" "}
          Quiver is applying its fallback filter after receipt.
        </div>
      )}

      {entities === undefined ? (
        <div className="ha-center">Loading entities…</div>
      ) : shown.length === 0 ? (
        <div className="ha-empty">
          {activeFilter
            ? "Nothing matches that filter."
            : "No entities yet. Once the connection is live, your home's lights, switches, and sensors show up here."}
        </div>
      ) : (
        <div className="ha-board">
          {shown.map((g) =>
            g.kind === "diagnostics" ? (
              <DiagnosticsDrawer key={g.key} group={g} call={call} />
            ) : (
              <AreaCard key={g.key} group={g} call={call} />
            ),
          )}
        </div>
      )}
    </>
  );
}

function StatusLed({ connection }: { connection: Connection | null | undefined }) {
  const cls =
    connection == null
      ? "ha-led"
      : connection.connected
        ? "ha-led ok"
        : "ha-led bad";
  const title =
    connection == null
      ? "Connecting…"
      : connection.connected
        ? "Connected"
        : "Disconnected";
  return <span className={cls} title={title} aria-label={title} />;
}

// Filter a grouped panel by a name/id substring, dropping emptied groups.
function filterGroups(groups: Group[], filter: string): Group[] {
  const q = filter.trim().toLowerCase();
  if (!q) return groups;
  const match = (e: Entity) =>
    name(e).toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q);
  return groups
    .map((g) => ({
      ...g,
      controls: g.controls.filter(match),
      readouts: g.readouts.filter(match),
    }))
    .filter((g) => g.controls.length + g.readouts.length > 0);
}

// ---- Debounce hook -------------------------------------------------------

function useDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), ms);
    },
    [fn, ms],
  );
}

// ---- Styles --------------------------------------------------------------
//
// Built on the platform's theme tokens (--app-bg, --text-*, --accent, …),
// so light/dark follow the shell. A thin app layer adds the instrument
// surfaces. Layout is container-query driven: a single column in the
// channel panel, a board of area cards when there's room.

const CSS = `
.ha {
  --ha-surface: #ffffff;
  --ha-raised: #eceef1;
  --ha-line: var(--topbar-border, #e3e5e8);
  --ha-on: var(--accent, #5865f2);
  --ha-ok: var(--accent-green, #23a559);
  --ha-warn: #cf8a2c;
  --ha-bad: var(--accent-red, #f23f43);

  box-sizing: border-box;
  min-height: 100%;
  padding: var(--space-lg, 16px);
  background: var(--app-bg, #f8f9fa);
  color: var(--text-primary, #1b1b22);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.4;
  container-type: inline-size;
}
[data-theme="dark"] .ha { --ha-surface: #232529; --ha-raised: #31343a; --ha-warn: #e0a548; }
.ha *, .ha *::before, .ha *::after { box-sizing: border-box; }
.ha-mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }

.ha-top { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
.ha-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ha-title { font-size: 15px; font-weight: 650; letter-spacing: -0.2px; margin: 0; white-space: nowrap; }
.ha-spacer { flex: 1; }
.ha-filter {
  font: inherit; font-size: 13px; color: var(--text-primary);
  background: var(--ha-surface); border: 1px solid var(--ha-line);
  border-radius: 8px; padding: 5px 10px; width: 160px; outline: none;
}
.ha-filter:focus { border-color: var(--ha-on); }

.ha-led {
  width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
  background: var(--ha-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ha-warn) 22%, transparent);
}
.ha-led.ok { background: var(--ha-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ha-ok) 22%, transparent); }
.ha-led.bad { background: var(--ha-bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ha-bad) 22%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .ha-led.ok { animation: ha-breathe 3.2s ease-in-out infinite; }
}
@keyframes ha-breathe { 0%, 100% { opacity: 1 } 50% { opacity: .5 } }

.ha-board { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
@container (min-width: 720px) {
  .ha-board { grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
}
.ha-board > .ha-diag { grid-column: 1 / -1; }

.ha-card { background: var(--ha-surface); border: 1px solid var(--ha-line); border-radius: 10px; overflow: hidden; container-type: inline-size; }
.ha-card-h { display: flex; align-items: baseline; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--ha-line); }
.ha-area { font-size: 11px; font-weight: 600; letter-spacing: .7px; text-transform: uppercase; color: var(--text-secondary); }
.ha-meta { margin-left: auto; font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ha-meta b { color: var(--ha-on); font-weight: 600; }

.ha-rows { display: flex; flex-direction: column; }
.ha-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; min-height: 42px; border-top: 1px solid color-mix(in srgb, var(--ha-line) 55%, transparent); position: relative; }
.ha-rows > .ha-row:first-child { border-top: none; }
.ha-rows > .ha-camrow:first-child > .ha-row { border-top: none; }
.ha-row[data-on="true"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--ha-on); }
.ha-ic { flex: 0 0 auto; color: var(--text-muted); opacity: .9; }
.ha-row[data-on="true"] .ha-ic { color: var(--ha-on); opacity: 1; }
.ha-name { font-size: 13.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.ha-row[data-on="true"] .ha-name { color: var(--text-primary); }
.ha-ctl { display: flex; align-items: center; gap: 9px; flex: 0 0 auto; }

.ha-val { font-size: 13px; color: var(--text-primary); }
.ha-unit { color: var(--text-muted); }
.ha-now { font-size: 12px; color: var(--text-muted); }
.ha-sub { font-size: 12px; color: var(--text-muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ha-toggle { width: 40px; height: 23px; border-radius: 999px; border: none; background: var(--ha-raised); position: relative; cursor: pointer; padding: 0; flex-shrink: 0; transition: background 120ms ease; }
.ha-toggle[aria-pressed="true"] { background: var(--ha-on); }
.ha-toggle:disabled { opacity: .55; cursor: default; }
.ha-knob { position: absolute; top: 2.5px; left: 2.5px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform 120ms ease; }
.ha-toggle[aria-pressed="true"] .ha-knob { transform: translateX(17px); }

.ha-slider { display: flex; align-items: center; gap: 9px; width: clamp(96px, 38cqw, 180px); }
.ha-range { flex: 1; accent-color: var(--ha-on); min-width: 56px; }
.ha-pct { font-size: 12px; color: var(--text-muted); min-width: 34px; text-align: right; }
.ha-row[data-on="true"] .ha-pct { color: var(--text-primary); }

.ha-step { display: flex; align-items: center; gap: 4px; }
.ha-stepbtn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--ha-line); background: var(--ha-raised); color: var(--text-primary); font-size: 16px; line-height: 1; cursor: pointer; }
.ha-stepbtn:disabled { opacity: .4; cursor: default; }
.ha-stepval { min-width: 44px; text-align: center; font-size: 13px; }

.ha-icon { width: 32px; height: 28px; border-radius: 6px; border: 1px solid var(--ha-line); background: var(--ha-raised); color: var(--text-primary); cursor: pointer; font-size: 11px; }
.ha-select { font: inherit; font-size: 12px; color: var(--text-primary); background: var(--ha-raised); border: 1px solid var(--ha-line); border-radius: 7px; padding: 4px 8px; max-width: 150px; cursor: pointer; }
.ha-select:disabled { opacity: .55; cursor: default; }
.ha-pills { display: flex; gap: 5px; }
.ha-pill { padding: 4px 10px; border-radius: 7px; border: 1px solid var(--ha-line); background: var(--ha-raised); color: var(--text-primary); cursor: pointer; font-size: 12px; }
.ha-pill:disabled { opacity: .55; cursor: default; }
.ha-pill.warn { border-color: var(--ha-warn); color: var(--ha-warn); background: transparent; }

.ha-diag { background: var(--ha-surface); border: 1px solid var(--ha-line); border-radius: 10px; }
.ha-diag > summary { list-style: none; cursor: pointer; padding: 9px 12px; font-size: 11px; font-weight: 600; letter-spacing: .7px; text-transform: uppercase; color: var(--text-muted); }
.ha-diag > summary::-webkit-details-marker { display: none; }

.ha-banner { padding: 8px 11px; border-radius: 8px; font-size: 12.5px; margin-bottom: 12px; border: 1px solid var(--ha-line); background: var(--ha-surface); }
.ha-banner.warn { color: var(--ha-warn); border-color: color-mix(in srgb, var(--ha-warn) 45%, var(--ha-line)); }
.ha-banner.err { color: var(--ha-bad); border-color: color-mix(in srgb, var(--ha-bad) 45%, var(--ha-line)); cursor: pointer; }

.ha-center { padding: 28px; text-align: center; color: var(--text-muted); }
.ha-empty { padding: 18px; border: 1px dashed var(--ha-line); border-radius: 10px; color: var(--text-muted); line-height: 1.5; }

.ha-pair { background: var(--ha-surface); border: 1px solid var(--ha-line); border-radius: 12px; padding: 18px; max-width: 560px; }
.ha-code { margin-top: 8px; padding: 11px 12px; background: var(--ha-raised); border: 1px solid var(--ha-line); border-radius: 8px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; user-select: all; word-break: break-all; }

.ha-camrow[data-on="true"] { background: color-mix(in srgb, var(--ha-on) 4%, transparent); }
.ha-cam { position: relative; margin: 0 12px 12px; border-radius: 8px; overflow: hidden; background: #000; aspect-ratio: 16 / 9; }
.ha-cam video { display: block; width: 100%; height: 100%; object-fit: contain; }
.ha-cam-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; text-align: center; font-size: 12.5px; color: #d6d8dc; pointer-events: none; }
`;
