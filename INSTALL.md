# Installing

Steps for an agent (or a person) setting this up for someone. There are two
halves: a Quiver app in one of the member's channels, and an integration in
their Home Assistant. Nothing needs to be cloned; both install straight from
this repository.

Before starting, find out:

- **Which quiver and channel** the house should live in. Anyone in that
  channel will be able to see and control the house.
- **How you can reach Home Assistant**, if at all: its URL plus a
  long-lived access token for an admin user (made under Profile → Security),
  or a shell on the machine. If you have neither, the member does the Home
  Assistant half by following links you give them.
- **Whether HACS is installed** in Home Assistant. It isn't required, but
  it's how the integration gets updates.

## 1. Quiver: install the app

```sh
quiver app add https://github.com/ficusk/ha-quiver.git#apps/home-assistant
quiver -c <channel> install home-assistant
```

If the quiver already has a `home-assistant` app, skip the `app add`. To
pick up new versions later, run `quiver app update home-assistant`.

## 2. Quiver: get the connect link

```sh
quiver -c <channel> call home-assistant.startPairing '{}' --json
```

This returns `{ otp, path }`. The connect link is `https://<quiver host>` +
`path`, for example `https://maple.quiver.city/ha/connect?otp=…`. The same
link also appears on the app's screen in the channel. It works once and lasts
a day.

## 3. Home Assistant: install the integration and pair

Pick the first route you can use.

**With a URL and token.** One command installs the integration through HACS,
restarts Home Assistant, and pairs it:

```sh
uv run https://raw.githubusercontent.com/ficusk/ha-quiver/main/scripts/ha_setup.py \
  --ha <home assistant url> --token <token> --link <connect link>
```

It skips whatever is already done, so it's safe to re-run. If HACS isn't
installed it says so and stops; use the next route for the install, then
run it again to pair.

**With a shell on the Home Assistant machine.** Copy `custom_components/quiver/`
from this repository into Home Assistant's `config/custom_components/`
directory and restart Home Assistant. Then pair, either by running the script
above with `--link`, or by having the member paste the link as below.

**Neither.** Send the member these, in order:

1. [Add this repository to HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=ficusk&repository=ha-quiver&category=integration),
   press **Download**, then restart Home Assistant (Settings → System →
   restart). No HACS? Install it first from [hacs.xyz](https://hacs.xyz), or
   copy the integration in by hand as above.
2. [Add the Quiver integration](https://my.home-assistant.io/redirect/config_flow_start/?domain=quiver)
   and paste the connect link when it asks.

## 4. Check it worked

```sh
quiver -c <channel> call home-assistant.connection '{}' --json
```

`connected: true` means the house is live, and the dashboard in the channel
fills in a few seconds later. If pairing failed, get a fresh link (step 2)
and try again; codes are single use.

Live camera video needs cameras that Home Assistant can show over WebRTC
(Nest, or most others through its built-in go2rtc). See the README.
