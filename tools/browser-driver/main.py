#!/usr/bin/env python3
"""Browser Driver backend — lets Muse drive the user's Chrome.

The user's Chrome extension opens one WebSocket to this server
(/ws/extension) and authenticates with the EXTENSION key. Muse calls the
REST API here with the CLAUDE key (X-API-Key header); each POST /command is
forwarded to the extension over the WebSocket and the result is returned.

Pattern follows MRET (FastAPI + uvicorn on 127.0.0.1, behind Caddy at
mret.aayushlife.live) and the Nexus resolver (stdlib-free, systemd unit,
keys only in /opt/<service>/.env). Port 8802: MRET uses 8799, Nexus 8801.

Keys (from /opt/browser-driver/.env, loaded by systemd EnvironmentFile):
  DRIVER_EXTENSION_API_KEY — the extension's key (pasted in its Options).
  DRIVER_CLAUDE_API_KEY    — Muse's key (held by the connector, never here
                             in chat or in code).
Run: uvicorn main:app --host 127.0.0.1 --port 8802
"""

import asyncio
import itertools
import json
import os
import secrets
import time
import uuid

from fastapi import FastAPI, Header, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# --- tiny .env loader (systemd EnvironmentFile is the real source on the
# VM; this only matters for local testing, where a .env may sit next to main.py)
_HERE = os.path.dirname(os.path.abspath(__file__))
_ENV_FILE = os.path.join(_HERE, ".env")
if os.path.exists(_ENV_FILE):
    for _line in open(_ENV_FILE, encoding="utf-8"):
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

EXTENSION_KEY = os.environ.get("DRIVER_EXTENSION_API_KEY", "")
CLAUDE_KEY = os.environ.get("DRIVER_CLAUDE_API_KEY", "")
PORT = int(os.environ.get("PORT", "8802"))

COMMAND_TIMEOUT = 30.0   # default wait for the extension to answer
COMMAND_TIMEOUT_MAX = 60.0

app = FastAPI(title="browser-driver", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # the API key still gates /command and /tabs
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# --- extension connection state (one extension, one socket) -------------
ext_ws: WebSocket | None = None
ext_lock = asyncio.Lock()
ext_last_seen: float = 0.0
ext_tabs: list = []
pending: dict[str, asyncio.Future] = {}
_cmd_counter = itertools.count(1)


def _unauth(detail: str):
    return JSONResponse({"detail": detail}, status_code=401)


def _check_claude_key(x_api_key: str | None):
    """Muse's key. Missing key and wrong key get the same answer."""
    if not CLAUDE_KEY or not x_api_key or not secrets.compare_digest(x_api_key, CLAUDE_KEY):
        return False
    return True


@app.get("/")
async def root():
    return {"service": "browser-driver", "ok": True}


@app.get("/health")
async def health():
    return {"ok": True, "extension_connected": ext_ws is not None}


async def _send_to_extension(msg: dict):
    async with ext_lock:
        ws = ext_ws
        if ws is None:
            return False
        try:
            await ws.send_text(json.dumps(msg))
            return True
        except Exception:
            return False


async def run_command(action: str, args: dict, timeout: float):
    """Send one command to the extension and wait for its {type: result}."""
    if ext_ws is None:
        return None, "extension_not_connected"
    cmd_id = f"cmd-{next(_cmd_counter)}-{uuid.uuid4().hex[:8]}"
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    pending[cmd_id] = fut
    try:
        if not await _send_to_extension({"type": "command", "id": cmd_id, "action": action, "args": args or {}}):
            return None, "extension_not_connected"
        try:
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return None, "command_timeout"
        return result, None
    finally:
        pending.pop(cmd_id, None)


@app.post("/command")
async def command(body: dict, x_api_key: str | None = Header(default=None, alias="X-API-Key")):
    if not _check_claude_key(x_api_key):
        return _unauth("invalid_api_key")
    action = (body or {}).get("action", "")
    args = (body or {}).get("args") or {}
    try:
        timeout = float((body or {}).get("timeout", COMMAND_TIMEOUT))
    except (TypeError, ValueError):
        timeout = COMMAND_TIMEOUT
    timeout = min(max(timeout, 1.0), COMMAND_TIMEOUT_MAX)
    if not action:
        return JSONResponse({"detail": "action is required"}, status_code=422)
    if ext_ws is None:
        return JSONResponse({"detail": "extension_not_connected"}, status_code=503)
    result, err = await run_command(action, args, timeout)
    if err == "extension_not_connected":
        return JSONResponse({"detail": "extension_not_connected"}, status_code=503)
    if err == "command_timeout":
        return JSONResponse({"detail": "command_timeout"}, status_code=504)
    return result  # {ok, result} or {ok:false, error} from the extension


@app.get("/tabs")
async def tabs(x_api_key: str | None = Header(default=None, alias="X-API-Key")):
    if not _check_claude_key(x_api_key):
        return _unauth("invalid_api_key")
    if ext_ws is None:
        return JSONResponse({"detail": "extension_not_connected"}, status_code=503)
    result, err = await run_command("list_tabs", {}, 10.0)
    if err:
        # Fall back to the last tab list the extension reported, if any.
        if ext_tabs:
            return {"ok": True, "result": ext_tabs, "cached": True}
        return JSONResponse({"detail": err}, status_code=503 if err == "extension_not_connected" else 504)
    return result


@app.websocket("/ws/extension")
async def ws_extension(ws: WebSocket):
    global ext_ws, ext_last_seen, ext_tabs
    await ws.accept()
    authed = False
    try:
        # First message must be the auth; anything else closes the socket.
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await ws.close(code=4400)
            return
        if msg.get("type") != "auth" or not msg.get("api_key") \
                or not EXTENSION_KEY or not secrets.compare_digest(str(msg["api_key"]), EXTENSION_KEY):
            await ws.close(code=4401)
            return
        authed = True
        ext_ws = ws
        ext_last_seen = time.time()
        await ws.send_text(json.dumps({"type": "auth_ok"}))
        # Keepalive pings while connected.
        async def pinger():
            while True:
                await asyncio.sleep(25)
                try:
                    await ws.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
        ping_task = asyncio.create_task(pinger())
        try:
            while True:
                raw = await ws.receive_text()
                ext_last_seen = time.time()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "pong":
                    continue
                if mtype == "tabs" and isinstance(msg.get("tabs"), list):
                    ext_tabs = msg["tabs"]
                    continue
                if mtype == "result" and msg.get("id") in pending:
                    fut = pending[msg["id"]]
                    if not fut.done():
                        fut.set_result({"ok": bool(msg.get("ok", True)),
                                        **({"result": msg["result"]} if "result" in msg else {}),
                                        **({"error": msg["error"]} if "error" in msg else {})})
        finally:
            ping_task.cancel()
    except (WebSocketDisconnect, asyncio.TimeoutError, asyncio.CancelledError):
        pass
    finally:
        if authed and ext_ws is ws:
            ext_ws = None
