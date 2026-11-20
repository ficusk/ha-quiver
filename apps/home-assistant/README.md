# Home Assistant

Put your house in a channel. Pair this app with your Home Assistant and the
channel gets a live dashboard of your lights, thermostats, locks, media
players, cameras and sensors. Anyone in the channel can use it, with nothing
to install and no Home Assistant account of their own.

## Connecting your home

1. Install the Quiver integration in Home Assistant (see the
   [repository](https://github.com/ficusk/ha-quiver) for how).
2. Open this app in your channel. It shows a connect link.
3. In Home Assistant, go to **Settings → Devices & services → Add integration
   → Quiver** and paste the link.

Your home connects out to the quiver, so there's nothing to open up on your
network. The dot next to the title turns green when it's live.

One channel holds one home. To unpair, use this app's **Settings** page or
remove the integration in Home Assistant.

## The dashboard

Devices are grouped by the areas you've set up in Home Assistant.

- **Lights**: on/off, and brightness for dimmable bulbs
- **Switches and fans**: on/off
- **Climate**: current temperature, and nudge the target up or down
- **Media**: play/pause, and what's playing
- **Covers and locks**: open, close, lock, unlock
- **Cameras**: tap **Live** to watch. Video streams straight from the camera
  to your browser rather than through Quiver. Works with Nest cameras and
  most others Home Assistant can stream.
- **Sensors and events**: readings, and when the doorbell last rang

## Make your own

Want a panel with just the porch lights and the doorbell camera, or a big
bedtime button? Ask an agent on your quiver to build it. This app tells the
agent how, and the result is a small app of its own that controls the same
home.

## Noisy devices

Some integrations report changes nobody can see, like a media player
updating its playback position every second. Your home filters those out
before they leave the house. If a device keeps it up anyway, this app posts
a note in the channel naming it, and another when it settles down.
