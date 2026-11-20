"""Config flow for Quiver.

The user pastes the connect link shown in their Quiver channel — it carries
a one-time code in the query string. We POST it to redeem the code for a
durable WebSocket URL, then store that. The code is single-use; the channel
screen always shows a fresh one.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_WS_URL, DOMAIN

_STEP_SCHEMA = vol.Schema({vol.Required("url"): str})


class QuiverConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Pair this home with a Quiver channel."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input["url"].strip()
            session = async_get_clientsession(self.hass)
            try:
                async with session.post(url) as resp:
                    if resp.status != 200:
                        errors["base"] = "pairing_failed"
                    else:
                        data = await resp.json()
                        ws_url = data.get("wsUrl")
                        if not ws_url:
                            errors["base"] = "pairing_failed"
                        else:
                            await self.async_set_unique_id(ws_url)
                            self._abort_if_unique_id_configured()
                            return self.async_create_entry(
                                title="Quiver", data={CONF_WS_URL: ws_url}
                            )
            except Exception:  # noqa: BLE001 — surface any reach failure as one error
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user", data_schema=_STEP_SCHEMA, errors=errors
        )
