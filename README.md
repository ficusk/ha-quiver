# Home Assistant for Quiver

Puts a Home Assistant install into a [Quiver](https://quiver.company)
channel. Everyone in the channel gets a live dashboard of the house (lights,
climate, locks, media, cameras, sensors) without installing anything or
having a Home Assistant account.

The house dials out to the quiver and holds the connection open. There are
no ports to forward and no long-lived token to paste anywhere.

This repo has three parts:

| Path | What it is |
|---|---|
| `custom_components/quiver/` | The Home Assistant integration. |
| `apps/home-assistant/` | The Quiver app: dashboard, pairing, and the API other apps build on. |
| `apps/lamp/` | A one-light remote, as an example of building on that API. |
| `scripts/ha_setup.py` | Installs and pairs the integration through Home Assistant's API. |

## Install

The quickest way is to ask an agent that can use your quiver: "Install
github.com/ficusk/ha-quiver in #home." [INSTALL.md](INSTALL.md) has the
steps it follows, and they work by hand too:

1. **In Quiver**, install the app in the channel the house should live in:

   ```sh
   quiver app add https://github.com/ficusk/ha-quiver.git#apps/home-assistant
   quiver -c home install home-assistant
   ```

   Open the app in the channel. It shows a connect link.

2. **In Home Assistant**,
   [add this repository to HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=ficusk&repository=ha-quiver&category=integration),
   download it, and restart. Without HACS, copy `custom_components/quiver/`
   into your `config/custom_components/` directory and restart. Requires
   Home Assistant 2024.12 or later.

3. [Add the Quiver integration](https://my.home-assistant.io/redirect/config_flow_start/?domain=quiver)
   and paste the connect link.

The dashboard fills in a few seconds later. The link works once and lasts a
day; reopening the channel shows the same link until it's used.

To unpair, remove the integration in Home Assistant, or open the app's
**Settings** page in Quiver (from the app's details page) and unpair the
channel there. Each channel holds one home. To share a second house, pair it
in another channel.

## What you get

The dashboard groups entities by the areas you've set up in Home Assistant,
and falls back to grouping by type if you haven't.

- Lights (on/off and brightness), switches, fans, input booleans
- Climate: current and target temperature
- Media players: play/pause and what's playing
- Covers and locks
- Number, select and button entities
- Cameras: live video (see below)
- Sensors, binary sensors, and events such as a doorbell press, shown read-only

Config and diagnostic entities go in a collapsed drawer at the bottom. Hidden
entities stay hidden.

### Cameras

Pressing **Live** on a camera opens a WebRTC stream in the dashboard. The
video doesn't go through the quiver. The browser connects directly to the
camera's stream source: Google's servers for a Nest camera, or Home
Assistant's built-in go2rtc for most RTSP cameras. Only the WebRTC handshake
travels over the link.

That means it works for any camera Home Assistant itself can show over
WebRTC. Cameras that only offer still images or HLS aren't supported yet.
A go2rtc stream has to reach the browser from your house, which usually works
through NAT, but networks that block it would need a TURN server, and this
doesn't set one up.

## Building your own UI

The Home Assistant app is also an API. Any other Quiver app in the same
channel can read the house's state and control it through cross-app calls,
with no backend of its own. Lamp is about 350 lines of UI and nothing else.

To build one, ask an agent on your quiver for it ("make me a panel with the
porch lights and the doorbell camera"). The app publishes a `facadeGuide`
tool that hands the agent the API and the conventions, so it doesn't need
this README.

The tools, briefly:

- `entities`, `areas`, `connection` (queries): the house's live state.
- `callService` (action): any Home Assistant service call.
- `cameraSignal` (action) and `cameraSession` (query): the WebRTC handshake for a
  camera's live view.

## How it works

```
Home Assistant ──WebSocket (dials out)──▶ quiver ──▶ channel dashboard
  integration   ◀── service calls,         bridge       and other apps
                    camera handshakes
```

Pairing: the channel mints a one-time code. The integration POSTs it to
`/ha/connect` on the quiver and gets back a WebSocket URL carrying a
per-channel secret, which is the only thing it stores. Each time it connects,
the bridge resolves that secret to a channel and binds the socket there.

After connecting, the integration sends a snapshot of every entity, then
each state change, plus a registry frame with areas and entity metadata
whenever those change. Service calls come back down the same socket.

Some integrations publish state far more often than anything visibly
changes. Media players that report their playback position every second are
the usual culprit. To keep that traffic off the internet, the quiver sends
the integration a small JavaScript filter on connect, and the integration
runs it on every outgoing frame. The filter runs in QuickJS with memory,
stack and time limits and gets JSON text only, with no access to Home
Assistant. If it fails to load or run, the integration says so and sends
everything unfiltered, and the quiver runs the same filter on arrival
anyway. When an entity is suppressed heavily for a sustained stretch, the app
posts a note in the channel naming it.

The integration and the app talk in JSON text frames. The protocol is
documented at the top of `custom_components/quiver/link.py` and
`apps/home-assistant/src/bridges/ha.ts`.

## Development

Quiver app tests and checks:

```sh
cd apps/home-assistant
bun install
bun test
quiver check
```

Integration tests. The edge relay tests need only QuickJS. The camera tests
import Home Assistant itself, which is a large install:

```sh
uv run --no-project --with quickjs-ng==0.16.0.1 \
  env PYTHONPATH=custom_components/quiver python -m unittest tests.test_edge_relay

uv run --no-project -p 3.13 \
  --with homeassistant --with quickjs-ng==0.16.0.1 \
  --with numpy --with PyTurboJPEG --with av --with ha-ffmpeg \
  env PYTHONPATH=custom_components/quiver python -m unittest discover -s tests
```

To try integration changes on a real Home Assistant, copy
`custom_components/quiver/` over the installed copy and restart Home
Assistant.

## License

MIT. See `LICENSE`.
