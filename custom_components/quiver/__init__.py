"""The Quiver integration — links this home to a Quiver channel."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_WS_URL, DOMAIN
from .link import QuiverLink


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Open the link and start streaming state up / running commands down."""
    link = QuiverLink(hass, entry.data[CONF_WS_URL])
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = link
    link.start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear the link down."""
    link: QuiverLink | None = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    if link is not None:
        await link.stop()
    return True
