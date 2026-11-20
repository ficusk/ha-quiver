// Live camera view. The browser opens a WebRTC connection straight to the
// camera's stream source; the handshake goes through `cameraSignal` (down to
// Home Assistant) and comes back in the `camera-sessions` Slate. See
// custom_components/quiver/camera.py for the other end.

import { useEffect, useRef, useState } from "react";
import { useAction, useSlate } from "@quiver/react";

interface CameraSession {
  entityId: string;
  config?: {
    configuration?: RTCConfiguration;
    dataChannel?: string;
  };
  answer?: string;
  candidates?: Record<string, RTCIceCandidateInit>;
  error?: { code: string; message: string };
}

type Status = "starting" | "connecting" | "live" | "failed";

const KEEPALIVE_MS = 60_000;
const ICE_GATHER_TIMEOUT_MS = 3_000;
const STATUS_TEXT: Record<Status, string> = {
  starting: "Asking Home Assistant for a stream…",
  connecting: "Connecting…",
  live: "",
  failed: "",
};

export function CameraView({ entityId }: { entityId: string }) {
  const signal = useAction("cameraSignal");
  const sessions = useSlate<CameraSession>("camera-sessions");
  const [sessionId] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<Status>("starting");
  const [failure, setFailure] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const remote = useRef<Promise<void> | null>(null);
  const applied = useRef(new Set<string>());

  const session = sessions.read(sessionId);
  const config = session?.config;
  const answer = session?.answer;
  const remoteError = session?.error;

  const fail = (err: unknown) => {
    setStatus("failed");
    setFailure(err instanceof Error ? err.message : String(err));
  };

  // Session lifetime: start on mount, keep alive, close on unmount.
  useEffect(() => {
    const send = (type: "start" | "keepalive" | "close") =>
      signal({ entityId, sessionId, type });
    send("start").catch(fail);
    const timer = setInterval(() => send("keepalive").catch(() => {}), KEEPALIVE_MS);
    return () => {
      clearInterval(timer);
      pc.current?.close();
      pc.current = null;
      send("close").catch(() => {});
    };
  }, [entityId, sessionId, signal]);

  // Config arrived: build the peer connection and send the offer.
  useEffect(() => {
    if (!config || pc.current) return;
    setStatus("connecting");
    const conn = new RTCPeerConnection(config.configuration);
    pc.current = conn;
    // Nest rejects offers whose m-lines aren't audio, video, data, in that
    // order; this is also the order Home Assistant's own frontend uses.
    conn.addTransceiver("audio", { direction: "recvonly" });
    conn.addTransceiver("video", { direction: "recvonly" });
    if (config.dataChannel) conn.createDataChannel(config.dataChannel);
    conn.ontrack = (ev) => {
      const el = video.current;
      if (el && !el.srcObject) el.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "connected") setStatus("live");
      if (conn.connectionState === "failed") fail("The video connection failed.");
    };
    (async () => {
      await conn.setLocalDescription(await conn.createOffer());
      await gatheringComplete(conn);
      const sdp = conn.localDescription?.sdp;
      if (!sdp) throw new Error("Couldn't create a video offer.");
      await signal({ entityId, sessionId, type: "offer", sdp });
    })().catch(fail);
  }, [config, entityId, sessionId, signal]);

  // Answer and remote candidates. Candidates can arrive before the answer is
  // applied; they wait in the Slate until it is.
  useEffect(() => {
    const conn = pc.current;
    if (!conn || !answer) return;
    void (async () => {
      remote.current ??= conn.setRemoteDescription({ type: "answer", sdp: answer });
      await remote.current;
      for (const [seq, c] of Object.entries(session?.candidates ?? {})) {
        if (applied.current.has(seq)) continue;
        applied.current.add(seq);
        await conn
          .addIceCandidate(
            c.sdpMid == null && c.sdpMLineIndex == null ? { ...c, sdpMLineIndex: 0 } : c,
          )
          .catch(() => {});
      }
    })().catch(fail);
  }, [answer, session?.candidates]);

  useEffect(() => {
    if (remoteError) fail(remoteError.message || remoteError.code);
  }, [remoteError]);

  return (
    <div className="ha-cam">
      <video ref={video} autoPlay playsInline muted controls />
      {status !== "live" && (
        <div className="ha-cam-status">
          {status === "failed" ? failure : STATUS_TEXT[status]}
        </div>
      )}
    </div>
  );
}

function gatheringComplete(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      conn.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (conn.iceGatheringState === "complete") done();
    };
    // Some networks never report "complete"; what's gathered by then is
    // usually enough.
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    conn.addEventListener("icegatheringstatechange", check);
  });
}
