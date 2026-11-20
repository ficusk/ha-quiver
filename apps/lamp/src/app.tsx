import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppContext, useApp } from "@quiver/react";

// The producer Lamp drives. Lamp declares nothing about it and it declares
// nothing about Lamp — co-installation in the channel is the whole contract.
const HA_APP = "home-assistant";

// Shape of one row from home-assistant's `entities` query. We only read the
// few fields a light needs; the producer carries the rest.
interface Entity {
  entityId: string;
  domain: string;
  state: string;
  attributes: Record<string, unknown>;
}

type CallService = (args: {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
}) => Promise<unknown>;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function lightName(e: Entity): string {
  const n = e.attributes.friendly_name;
  if (typeof n === "string" && n) return n;
  return e.entityId.replace(/^light\./, "").replace(/_/g, " ");
}

export default function App() {
  const context = useAppContext();
  const ha = useApp(HA_APP);

  // Cross-app reads and the control caller are React hooks — call them every
  // render in stable order, then branch. `useQuery` auto-skips (stays
  // undefined) until home-assistant is installed in this channel.
  const entities = ha.useQuery("entities") as Entity[] | undefined;
  const connection = ha.useQuery("connection") as
    | { connected: boolean }
    | null
    | undefined;
  const call = ha.useAction("callService") as CallService;

  if (!context) return <Splash>Connecting…</Splash>;

  if (!ha.isInstalled) {
    return (
      <Splash>
        <b>Lamp needs the Home Assistant connector.</b>
        Add Home Assistant to this channel and pair your home — then Lamp can
        drive its lights.
      </Splash>
    );
  }

  if (entities === undefined) return <Splash>Looking for your lights…</Splash>;

  const lights = entities
    .filter((e) => e.domain === "light")
    .sort((a, b) => lightName(a).localeCompare(lightName(b)));

  if (lights.length === 0) {
    return (
      <Splash>
        <b>No lights yet.</b>
        Once your home is connected, its lights show up here.
      </Splash>
    );
  }

  return (
    <Remote
      lights={lights}
      offline={connection != null && !connection.connected}
      call={call}
    />
  );
}

function Remote({
  lights,
  offline,
  call,
}: {
  lights: Entity[];
  offline: boolean;
  call: CallService;
}) {
  const [selected, setSelected] = useState(lights[0].entityId);
  const light = lights.find((l) => l.entityId === selected) ?? lights[0];

  return (
    <div className="lamp">
      <style>{CSS}</style>
      <div className="lamp-head">
        <span className="lamp-name">{lightName(light)}</span>
        {offline && <span className="lamp-tag">home offline</span>}
      </div>

      {/* Re-keyed per light so optimistic state resets when you switch. */}
      <LightControl key={light.entityId} light={light} call={call} />

      {lights.length > 1 && (
        <label className="lamp-pick">
          <span>Controlling</span>
          <select
            value={light.entityId}
            onChange={(e) => setSelected(e.target.value)}
          >
            {lights.map((l) => (
              <option key={l.entityId} value={l.entityId}>
                {lightName(l)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="lamp-via">via Home Assistant</div>
    </div>
  );
}

function LightControl({ light, call }: { light: Entity; call: CallService }) {
  const realOn = light.state === "on";
  const modes = light.attributes.supported_color_modes;
  const dimmable =
    num(light.attributes.brightness) !== undefined ||
    (Array.isArray(modes) && modes.some((m) => m !== "onoff"));
  const realPct = realOn
    ? Math.round(((num(light.attributes.brightness) ?? 0) / 255) * 100)
    : 0;

  // callService is fire-and-forget at the quiver — it returns before the
  // light actually changes, and the real state arrives a beat later through
  // the reactive `entities` query. So we show our intent optimistically and
  // hand back to the real value once it catches up (or after a 1.5s grace).
  // This mirrors the Home Assistant app's own LightControl.
  const [optOn, setOptOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (optOn === null) return;
    if (realOn === optOn) {
      setOptOn(null);
      return;
    }
    const t = setTimeout(() => setOptOn(null), 1500);
    return () => clearTimeout(t);
  }, [optOn, realOn]);

  const [optPct, setOptPct] = useState<number | null>(null);
  useEffect(() => {
    if (optPct === null) return;
    if (realOn && Math.abs(realPct - optPct) <= 1) {
      setOptPct(null);
      return;
    }
    const t = setTimeout(() => setOptPct(null), 1500);
    return () => clearTimeout(t);
  }, [optPct, realPct, realOn]);

  const on = optOn ?? realOn;
  const pct = optPct ?? realPct;

  const commit = useDebounced((value: number) => {
    void call({
      domain: "light",
      service: "turn_on",
      data: { entity_id: light.entityId, brightness_pct: value },
    });
  }, 200);

  const toggle = () => {
    const next = !on;
    setOptOn(next);
    void call({
      domain: "light",
      service: next ? "turn_on" : "turn_off",
      data: { entity_id: light.entityId },
    });
  };

  const slide = (value: number) => {
    setOptPct(value);
    setOptOn(value > 0);
    commit(value);
  };

  // The orb glows warmer and brighter the higher the brightness.
  const glow = on ? (0.28 + (pct / 100) * 0.55).toFixed(3) : "0";
  const orbStyle = on
    ? {
        background:
          "radial-gradient(circle at 50% 33%, #fff7d6, #ffd363 58%, #f2a02f)",
        borderColor: "transparent",
        boxShadow: `0 0 ${Math.round(22 + pct * 0.9)}px rgba(255,186,64,${glow}), inset 0 -8px 22px rgba(170,104,0,.22)`,
      }
    : undefined;

  return (
    <div className="lamp-stage">
      <button
        type="button"
        className={`lamp-orb${on ? " on" : ""}`}
        style={orbStyle}
        onClick={toggle}
        aria-pressed={on}
        aria-label={`${lightName(light)} — turn ${on ? "off" : "on"}`}
      >
        <BulbMark on={on} />
        <span className="lamp-state">
          {on ? (dimmable ? `${pct}%` : "On") : "Off"}
        </span>
      </button>

      {dimmable && (
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          className="lamp-range"
          onChange={(e) => slide(Number(e.target.value))}
          aria-label={`${lightName(light)} brightness`}
        />
      )}
    </div>
  );
}

function BulbMark({ on }: { on: boolean }) {
  return (
    <svg
      className="lamp-bulb"
      width="44"
      height="44"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.45.9.9.9 1.7V16h5.4v-.5c0-.8.3-1.25.9-1.7A6 6 0 0 0 12 3Z"
        stroke={on ? "rgba(120,70,0,.85)" : "currentColor"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <div className="lamp lamp--splash">
      <style>{CSS}</style>
      <div className="lamp-splash-card">{children}</div>
    </div>
  );
}

// Debounce the brightness commits so a drag fires one service call at rest,
// not one per slider tick.
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

// Built on the platform theme tokens (--app-bg, --text-*, …) so it follows
// the shell's light/dark, with a warm lamp layer on top.
const CSS = `
.lamp {
  box-sizing: border-box;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  padding: 36px 20px;
  background: var(--app-bg, #f7f7f9);
  color: var(--text-primary, #1b1b22);
  font-family: var(--font-sans, system-ui, sans-serif);
  text-align: center;
  --lamp-off: #e9ebef;
}
[data-theme="dark"] .lamp { --lamp-off: #2a2c31; }
.lamp * { box-sizing: border-box; }

.lamp-head { display: flex; align-items: center; gap: 10px; min-height: 22px; }
.lamp-name { font-size: 17px; font-weight: 650; letter-spacing: -0.2px; }
.lamp-tag {
  font-size: 11px; color: var(--text-muted, #888);
  border: 1px solid var(--topbar-border, #e3e5e8);
  border-radius: 999px; padding: 2px 8px;
}

.lamp-stage { display: flex; flex-direction: column; align-items: center; gap: 26px; }

.lamp-orb {
  width: 184px; height: 184px; border-radius: 50%;
  border: 1px solid var(--topbar-border, #e3e5e8);
  background: var(--lamp-off);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; color: var(--text-muted, #9aa0a6);
  transition: box-shadow 220ms ease, background 220ms ease, transform 110ms ease, color 220ms ease;
  -webkit-tap-highlight-color: transparent;
}
.lamp-orb:active { transform: scale(0.97); }
.lamp-orb.on { color: rgba(110, 64, 0, 0.9); }
.lamp-bulb { display: block; }
.lamp-state {
  font-size: 22px; font-weight: 600; letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}

.lamp-range {
  width: 220px; max-width: 80vw; height: 4px;
  accent-color: #f2a834;
}

.lamp-pick { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted, #888); }
.lamp-pick select {
  font: inherit; font-size: 12px; color: var(--text-primary, #1b1b22);
  background: var(--app-bg, #fff); border: 1px solid var(--topbar-border, #e3e5e8);
  border-radius: 7px; padding: 4px 8px;
}

.lamp-via { font-size: 11px; color: var(--text-muted, #9aa0a6); letter-spacing: 0.3px; }

.lamp--splash { gap: 0; }
.lamp-splash-card {
  max-width: 360px; display: flex; flex-direction: column; gap: 8px;
  color: var(--text-muted, #777); line-height: 1.5; font-size: 14px;
}
.lamp-splash-card b { color: var(--text-primary, #1b1b22); font-size: 15px; }
`;
