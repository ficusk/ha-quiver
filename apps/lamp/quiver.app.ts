import type { AppManifest } from "@quiver/system";

// Lamp is a facade: no backend and no Home Assistant connection of its own.
// It reads the `home-assistant` app's `entities` query and calls its
// `callService` action. Both apps live in the same channel, and that
// co-install is the whole authorization.
const manifest: AppManifest = {
  displayName: "Lamp",
  summary:
    "A big, one-tap on/off + brightness remote for a single Home Assistant light.",
  description:
    "A custom face over your Home Assistant connection. Lamp doesn't talk to your home directly — it calls the Home Assistant app installed in this channel to read your lights and switch one on, off, or dim it. Add Home Assistant to the channel, pair your home, and Lamp lights up.",
  categories: ["home"],
  entrypoints: {
    channel: "src/app.tsx",
  },
};

export default manifest;
