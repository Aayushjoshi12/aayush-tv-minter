"""Test: does the API login grant a FULL session when a device UUID is sent?

The VM's API login (no device UUID) returns only a PARTIAL session
(SESSION + auid cookies) and token/refresh returns nothing. His Chrome's
full session carries device UUID cookies che_g and fatman_uuid (both 36-char
UUIDs, set by the site's HDF script). Hypothesis: the server only issues the
full session (uhash + access_token JWT + authenticated) when the login
carries a device UUID.

Reads spare creds from /opt/cinema/.env (ONEX_USER / ONEX_PASS).
Logs cookie NAMES + lengths only — never values.
Run on the VM as: sudo -u cinema /opt/cinema/.venv/bin/python test-device-uuid-login.py
"""
import json
import os
import sys
import uuid

import httpx

BASE = "https://1xlite-6229051.com"


def _read_creds():
    user = os.environ.get("ONEX_USER")
    password = os.environ.get("ONEX_PASS")
    try:
        with open("/opt/cinema/.env") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "ONEX_USER":
                    user = user or v.strip().strip('"').strip("'")
                elif k.strip() == "ONEX_PASS":
                    password = password or v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return user, password


def _device_uuid():
    path = "/opt/cinema/.device_uuid"
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        uid = str(uuid.uuid4())
        with open(path, "w") as f:
            f.write(uid)
        return uid


def _cookie_summary(resp):
    out = {}
    for value in resp.headers.get_list("set-cookie"):
        # value looks like "NAME=...; Path=/; ..."
        pair = value.split(";", 1)[0]
        if "=" in pair:
            k, v = pair.split("=", 1)
            out[k.strip()] = len(v.strip())
    return out


def main():
    user, password = _read_creds()
    if not user or not password:
        print("NO_CREDS")
        return 1
    device = _device_uuid()
    result = {"device_uuid_len": len(device)}
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36"),
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://1xlite-6229051.com",
        "Referer": "https://1xlite-6229051.com/en/",
    }
    # Send the device UUID as the site's HDF cookies do.
    cookies = {"che_g": device, "fatman_uuid": device}
    with httpx.Client(base_url=BASE, timeout=30.0, follow_redirects=False) as c:
        login = c.post(
            "/web-api/api/internal/office/account/login",
            json={"login": user, "password": password, "authByEmail": False},
            headers=headers, cookies=cookies)
        result["login_status"] = login.status_code
        result["login_cookies"] = _cookie_summary(login)
        # Carry the session cookies forward, keep the device UUID.
        jar = dict(cookies)
        for value in login.headers.get_list("set-cookie"):
            pair = value.split(";", 1)[0]
            if "=" in pair:
                k, v = pair.split("=", 1)
                jar[k.strip()] = v.strip()
        refresh = c.post(
            "/web-api/api/internal/user/token/refresh",
            json={"initiator": "login"},
            headers=headers, cookies=jar)
        result["refresh_status"] = refresh.status_code
        result["refresh_cookies"] = _cookie_summary(refresh)
        names = set(result["login_cookies"]) | set(result["refresh_cookies"])
        result["full_session"] = {"uhash", "access_token",
                                  "authenticated"} <= names
        result["verdict"] = (
            "FULL_SESSION: device UUID unlocked the full session — "
            "wire it into the minter" if result["full_session"] else
            "PARTIAL_SESSION: device UUID did not help — the server "
            "distrusts this VM/IP regardless; API login from the VM "
            "cannot get a full session")
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
