import { useCallback, useState } from "react";
import { useAppContext, useQuery, useMutation } from "@quiver/react";

// Quiver-wide Settings (the `global` entrypoint), opened from the app's
// details page with no channel. Pairing state lives in the quiver-scoped
// `homes` table, so this is the one place that sees every paired home and
// can unpair one. Reads `listHomes`, writes `unpairHome`.

interface HomeRow {
  channelId: string;
  createdAt: number;
  connected?: boolean;
  lastError?: string;
  lastSeen?: number;
  entityCount?: number;
}

interface PendingRow {
  channelId: string;
  expiresAt: number;
}

interface HomesResult {
  homes: HomeRow[];
  pending: PendingRow[];
}

// Epoch-ms → short relative label. Runs in the browser, so Date.now() is fine.
function ago(ts?: number): string | null {
  if (!ts) return null;
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function untilExpiry(ts: number): string {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return "expiring";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  return `${h}h left`;
}

export default function Settings() {
  const context = useAppContext();
  const data = useQuery("listHomes", context ? {} : "skip") as
    | HomesResult
    | undefined;
  const unpairHome = useMutation("unpairHome");
  const [error, setError] = useState<string | null>(null);

  const unpair = useCallback(
    async (channelId: string) => {
      setError(null);
      try {
        await unpairHome({ targetChannelId: channelId });
        // listHomes is reactive — the row drops on its own once committed.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [unpairHome],
  );

  const homes = data?.homes ?? [];
  const pending = data?.pending ?? [];

  return (
    <div className="qs">
      <style>{CSS}</style>

      <header className="qs-top">
        <div className="qs-brand">
          <span className="qs-led" />
          <div>
            <h1 className="qs-title">Home Assistant · Settings</h1>
            <p className="qs-sub">
              Every home paired to this quiver. Unpair one to free its channel
              to connect again — no need to remove the whole app.
            </p>
          </div>
        </div>
      </header>

      {error && (
        <div className="qs-banner err" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {data === undefined ? (
        <div className="qs-center">Loading…</div>
      ) : homes.length === 0 && pending.length === 0 ? (
        <div className="qs-empty">
          No homes paired anywhere in this quiver yet. Add the Home Assistant
          app to a channel and pair your home from its dashboard; it shows up
          here once it's connected.
        </div>
      ) : (
        <>
          {homes.length > 0 && (
            <section className="qs-section">
              <h2 className="qs-h2">
                Paired homes <span className="qs-count">{homes.length}</span>
              </h2>
              <div className="qs-list">
                {homes.map((h) => (
                  <HomeCard key={h.channelId} home={h} onUnpair={unpair} />
                ))}
              </div>
            </section>
          )}

          {pending.length > 0 && (
            <section className="qs-section">
              <h2 className="qs-h2">
                Waiting to pair{" "}
                <span className="qs-count">{pending.length}</span>
              </h2>
              <p className="qs-note">
                These channels have a live connect link but no home has redeemed
                it yet.
              </p>
              <div className="qs-list">
                {pending.map((p) => (
                  <div key={p.channelId} className="qs-card pending">
                    <span className="qs-led warn" />
                    <div className="qs-card-main">
                      <ChannelId id={p.channelId} />
                      <span className="qs-meta">{untilExpiry(p.expiresAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function HomeCard({
  home,
  onUnpair,
}: {
  home: HomeRow;
  onUnpair: (channelId: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onUnpair(home.channelId);
    } catch {
      /* surfaced via the page-level banner */
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const known = home.connected !== undefined;
  const ledClass = !known
    ? "qs-led"
    : home.connected
      ? "qs-led ok"
      : "qs-led bad";
  const statusText = !known
    ? "Status unknown"
    : home.connected
      ? "Connected"
      : home.lastError
        ? `Offline — ${home.lastError}`
        : "Offline";
  const seen = ago(home.lastSeen);

  return (
    <div className="qs-card">
      <span className={ledClass} title={statusText} />
      <div className="qs-card-main">
        <ChannelId id={home.channelId} />
        <span className="qs-meta">
          {statusText}
          {typeof home.entityCount === "number" && (
            <>
              {" · "}
              {home.entityCount} {home.entityCount === 1 ? "entity" : "entities"}
            </>
          )}
          {seen && <> · seen {seen}</>}
        </span>
        <span className="qs-sub2">Paired {ago(home.createdAt) ?? "—"}</span>
      </div>

      <div className="qs-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="qs-btn danger"
              disabled={busy}
              onClick={run}
            >
              {busy ? "Unpairing…" : "Confirm unpair"}
            </button>
            <button
              type="button"
              className="qs-btn ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="qs-btn"
            onClick={() => setConfirming(true)}
          >
            Unpair
          </button>
        )}
      </div>
    </div>
  );
}

// Channel ids are opaque, so show a head/tail with the full value on hover and
// select-all to copy. There's no platform hook to resolve a channel's name
// from a global frame, so the id is the honest identifier here.
function ChannelId({ id }: { id: string }) {
  const short = id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  return (
    <span className="qs-chan ha-mono" title={id}>
      {short}
    </span>
  );
}

const CSS = `
.qs {
  --qs-surface: #ffffff;
  --qs-raised: #eceef1;
  --qs-line: var(--topbar-border, #e3e5e8);
  --qs-ok: var(--accent-green, #23a559);
  --qs-warn: #cf8a2c;
  --qs-bad: var(--accent-red, #f23f43);
  --qs-accent: var(--accent, #5865f2);

  box-sizing: border-box;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-lg, 20px);
  background: var(--app-bg, #f8f9fa);
  color: var(--text-primary, #1b1b22);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.45;
}
[data-theme="dark"] .qs { --qs-surface: #232529; --qs-raised: #31343a; --qs-warn: #e0a548; }
.qs *, .qs *::before, .qs *::after { box-sizing: border-box; }
.ha-mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }

.qs-top { display: flex; margin-bottom: 18px; }
.qs-brand { display: flex; align-items: flex-start; gap: 11px; }
.qs-title { font-size: 17px; font-weight: 650; letter-spacing: -0.2px; margin: 0; }
.qs-sub { margin: 4px 0 0; font-size: 13px; color: var(--text-muted); max-width: 52ch; }

.qs-led {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 5px;
  background: var(--qs-raised);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--qs-raised) 40%, transparent);
}
.qs-led.ok { background: var(--qs-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--qs-ok) 22%, transparent); }
.qs-led.bad { background: var(--qs-bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--qs-bad) 22%, transparent); }
.qs-led.warn { background: var(--qs-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--qs-warn) 22%, transparent); }

.qs-section { margin-top: 22px; }
.qs-h2 { font-size: 12px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; color: var(--text-secondary); margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
.qs-count { font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--qs-raised); border-radius: 999px; padding: 1px 8px; }
.qs-note { margin: -4px 0 10px; font-size: 12.5px; color: var(--text-muted); }

.qs-list { display: flex; flex-direction: column; gap: 9px; }
.qs-card { display: flex; align-items: flex-start; gap: 11px; padding: 12px 14px; background: var(--qs-surface); border: 1px solid var(--qs-line); border-radius: 10px; }
.qs-card.pending { align-items: center; }
.qs-card-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.qs-chan { font-size: 13.5px; color: var(--text-primary); font-weight: 550; }
.qs-meta { font-size: 12.5px; color: var(--text-secondary); }
.qs-sub2 { font-size: 11.5px; color: var(--text-muted); }

.qs-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
.qs-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--qs-line); background: var(--qs-raised); color: var(--text-primary); cursor: pointer; font: inherit; font-size: 12.5px; white-space: nowrap; }
.qs-btn:hover { border-color: color-mix(in srgb, var(--text-muted) 50%, var(--qs-line)); }
.qs-btn.danger { background: var(--qs-bad); border-color: var(--qs-bad); color: #fff; }
.qs-btn.ghost { background: transparent; }
.qs-btn:disabled { opacity: .6; cursor: default; }

.qs-banner { padding: 9px 12px; border-radius: 8px; font-size: 12.5px; margin-bottom: 12px; border: 1px solid var(--qs-line); background: var(--qs-surface); }
.qs-banner.err { color: var(--qs-bad); border-color: color-mix(in srgb, var(--qs-bad) 45%, var(--qs-line)); cursor: pointer; }

.qs-center { padding: 30px; text-align: center; color: var(--text-muted); }
.qs-empty { padding: 18px; border: 1px dashed var(--qs-line); border-radius: 10px; color: var(--text-muted); line-height: 1.55; }

@media (max-width: 460px) {
  .qs-card { flex-wrap: wrap; }
  .qs-actions { width: 100%; justify-content: flex-end; }
}
`;
