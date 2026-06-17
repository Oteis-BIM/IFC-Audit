from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from typing import Any

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import ifcopenshell

from scripts.check_ifc_props import check_request


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def download_box_file(file_id: str, access_token: str, output_path: str) -> None:
    request = urllib.request.Request(
        f"https://api.box.com/2.0/files/{file_id}/content",
        headers={"Authorization": f"Bearer {access_token}"},
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            with open(output_path, "wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"Erreur Box {err.code}") from err


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))

            file_id = payload.get("fileId")
            requests = payload.get("requests") or []
            access_token = payload.get("accessToken")

            if not file_id:
                json_response(self, 400, {"error": "fileId requis"})
                return
            if not access_token:
                json_response(self, 401, {"error": "Token Box requis"})
                return
            if not requests:
                json_response(self, 200, {"results": [], "engine": "ifcopenshell"})
                return

            with tempfile.TemporaryDirectory(prefix="ifc-props-") as tmp_dir:
                ifc_path = os.path.join(tmp_dir, "model.ifc")
                download_box_file(file_id, access_token, ifc_path)

                model = ifcopenshell.open(ifc_path)
                elements = list(model.by_type("IfcObject"))
                results = [check_request(elements, request) for request in requests]

            json_response(self, 200, {"results": results, "engine": "ifcopenshell"})
        except Exception as err:
            json_response(self, 500, {"error": str(err)})

