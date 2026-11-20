# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=13"]
# ///
"""Install the Quiver integration in Home Assistant and pair it with a channel.

    uv run scripts/ha_setup.py --ha http://homeassistant.local:8123 \\
        --token "$HA_TOKEN" --link https://example.quiver.city/ha/connect?otp=…

Needs a long-lived access token for an admin user (Profile → Security in
Home Assistant). Each step is skipped if it's already done:

1. If the integration isn't installed, add this repository to HACS as a
   custom repository, download it, and restart Home Assistant.
2. If no Quiver entry exists, run the integration's setup with the link.

Without HACS it stops after telling you so; copy custom_components/quiver/
into Home Assistant's config directory, restart, and run this again.
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import sys
import time
import urllib.error
import urllib.request

from websockets.asyncio.client import connect

REPO = "ficusk/ha-quiver"
DOMAIN = "quiver"


class HAError(Exception):
    pass


class Session:
    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token
        self._ids = itertools.count(1)

    # REST

    def rest(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as err:
            raise HAError(f"{method} {path}: {err.code} {err.read().decode()[:300]}")

    # WebSocket

    async def __aenter__(self) -> Session:
        ws_url = self.base.replace("http", "ws", 1) + "/api/websocket"
        self.ws = await connect(ws_url, max_size=None)
        await self.ws.recv()  # auth_required
        await self.ws.send(json.dumps({"type": "auth", "access_token": self.token}))
        reply = json.loads(await self.ws.recv())
        if reply.get("type") != "auth_ok":
            raise HAError("Home Assistant rejected the token.")
        return self

    async def __aexit__(self, *exc) -> None:
        await self.ws.close()

    async def call(self, kind: str, **fields):
        msg_id = next(self._ids)
        await self.ws.send(json.dumps({"id": msg_id, "type": kind, **fields}))
        while True:
            reply = json.loads(await self.ws.recv())
            if reply.get("id") == msg_id and reply.get("type") == "result":
                if not reply["success"]:
                    err = reply.get("error", {})
                    raise HAError(f"{kind}: {err.get('code')}: {err.get('message')}")
                return reply.get("result")


async def integration_installed(ha: Session) -> bool:
    try:
        await ha.call("manifest/get", integration=DOMAIN)
        return True
    except HAError:
        return False


async def install_with_hacs(ha: Session) -> None:
    try:
        repos = await ha.call("hacs/repositories/list", categories=["integration"])
    except HAError:
        raise HAError(
            "HACS isn't installed. Copy custom_components/quiver/ from "
            f"https://github.com/{REPO} into Home Assistant's config/custom_components/, "
            "restart Home Assistant, and run this again."
        )
    repo = next((r for r in repos if r["full_name"].lower() == REPO), None)
    if repo is None:
        print(f"Adding {REPO} to HACS…")
        await ha.call("hacs/repositories/add", repository=REPO, category="integration")
        repos = await ha.call("hacs/repositories/list", categories=["integration"])
        repo = next((r for r in repos if r["full_name"].lower() == REPO), None)
        if repo is None:
            raise HAError("HACS didn't register the repository; check its logs.")
    print(f"Downloading {repo['name']} {repo['available_version']}…")
    await ha.call("hacs/repository/download", repository=str(repo["id"]))


def restart_and_wait(ha: Session) -> None:
    print("Restarting Home Assistant…")
    try:
        ha.rest("POST", "/api/services/homeassistant/restart", {})
    except (HAError, OSError):
        pass  # the connection often drops mid-reply
    time.sleep(15)
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            if ha.rest("GET", "/api/").get("message"):
                time.sleep(10)  # let integrations finish loading
                return
        except (HAError, OSError):
            pass
        time.sleep(5)
    raise HAError("Home Assistant didn't come back within five minutes.")


def pair(ha: Session, link: str) -> None:
    flow = ha.rest("POST", "/api/config/config_entries/flow", {"handler": DOMAIN})
    if flow.get("type") == "abort":
        raise HAError(f"Setup refused: {flow.get('reason')}")
    result = ha.rest(
        "POST", f"/api/config/config_entries/flow/{flow['flow_id']}", {"url": link}
    )
    if result.get("type") == "create_entry":
        print("Paired. The channel's dashboard fills in within a few seconds.")
        return
    if result.get("type") == "abort":
        raise HAError(f"Setup aborted: {result.get('reason')}")
    raise HAError(
        f"Pairing failed ({result.get('errors')}). The link is single-use; "
        "get a fresh one from the channel and try again."
    )


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--ha", required=True, help="Home Assistant URL")
    parser.add_argument("--token", required=True, help="long-lived admin token")
    parser.add_argument("--link", help="the channel's connect link")
    args = parser.parse_args()

    ha = Session(args.ha, args.token)
    async with ha:
        installed = await integration_installed(ha)
        if not installed:
            await install_with_hacs(ha)
    if not installed:
        restart_and_wait(ha)
        async with ha:
            if not await integration_installed(ha):
                raise HAError("The integration still isn't loaded after the restart.")
    print("Integration installed.")

    async with ha:
        entries = await ha.call("config_entries/get", domain=DOMAIN)
    if entries:
        print("Already paired. To pair a different channel, remove the Quiver "
              "integration in Home Assistant first.")
        return 0
    if not args.link:
        print("Pass --link with the channel's connect link to finish pairing.")
        return 0
    pair(ha, args.link)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except HAError as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(1)
    except OSError as err:
        print(f"error: can't reach Home Assistant: {err}", file=sys.stderr)
        sys.exit(1)
