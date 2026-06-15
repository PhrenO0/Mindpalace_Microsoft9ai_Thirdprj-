from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Mind Palace API", version="0.1.0")
ROOT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
LEGACY_DIR = ROOT_DIR / "frontend" / "public" / "legacy"

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DetectRequest(BaseModel):
    imageBase64: str
    width: int | None = None
    height: int | None = None


def azure_vision_config() -> tuple[str, str]:
    endpoint = (
        os.getenv("AZURE_VISION_ENDPOINT")
        or os.getenv("AZURE_AI_VISION_ENDPOINT")
        or os.getenv("VISION_ENDPOINT")
        or ""
    ).strip()
    key = (
        os.getenv("AZURE_VISION_KEY")
        or os.getenv("AZURE_AI_VISION_KEY")
        or os.getenv("VISION_KEY")
        or ""
    ).strip()
    return endpoint.rstrip("/"), key


@app.get("/api/health")
def health() -> dict:
    azure_endpoint, azure_key = azure_vision_config()
    return {
        "ok": True,
        "app": "memory-palace-vworld",
        "mode": "react-fastapi-legacy-preserved",
        "vworldKeyConfigured": bool(os.getenv("VWORLD_API_KEY")),
        "azureVisionConfigured": bool(azure_endpoint and azure_key),
    }


@app.get("/api/client-config")
def client_config() -> dict:
    return {
        "vworldApiKey": os.getenv("VWORLD_API_KEY", ""),
    }


@app.get("/api/vision-config")
def vision_config() -> dict:
    endpoint, key = azure_vision_config()
    return {
        "azure": bool(endpoint and key),
    }


@app.post("/api/detect")
def detect_objects(payload: DetectRequest) -> dict:
    endpoint, key = azure_vision_config()
    if not endpoint or not key:
        return {"configured": False, "objects": [], "captions": []}

    try:
        image_bytes = decode_data_url(payload.imageBase64)
        result = call_azure_image_analysis(endpoint, key, image_bytes)
        return {
            "configured": True,
            "objects": map_azure_objects(result, payload.width, payload.height),
            "captions": map_azure_dense_captions(result, payload.width, payload.height),
        }
    except requests.HTTPError as exc:
        detail = exc.response.text[:600] if exc.response is not None else str(exc)
        raise HTTPException(status_code=502, detail=f"Azure Vision request failed: {detail}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/integrations/pdf/status")
def pdf_integration_status() -> dict:
    return {
        "enabled": False,
        "state": "reserved",
        "message": "PDF upload, Python extraction, and GraphRAG mapping are reserved for the next integration step.",
        "futureEndpoints": [
            "POST /api/integrations/pdf/upload",
            "POST /api/integrations/graphrag/build",
            "PATCH /api/palace/rooms/{room_id}/nodes",
        ],
    }


if LEGACY_DIR.exists():
    app.mount("/legacy", StaticFiles(directory=LEGACY_DIR, html=True), name="legacy")


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    def serve_frontend_index() -> RedirectResponse:
        # 단일 진입점 통합: 루트(/)를 정본 흐름(지역 선택 → 지도 → 방)으로 리다이렉트.
        #   기존 Mind Palace SPA(dist)는 보존되며 직접 경로로는 접근 가능하나, 진입은 region-select로 일원화.
        return RedirectResponse("/legacy/region-select.html")

    @app.get("/{path:path}")
    def serve_frontend_path(path: str) -> FileResponse:
        target = FRONTEND_DIST / path
        if target.is_file():
            return FileResponse(target)
        return FileResponse(FRONTEND_DIST / "index.html")
elif LEGACY_DIR.exists():

    @app.get("/")
    def serve_legacy_entry() -> RedirectResponse:
        return RedirectResponse("/legacy/region-select.html")


def decode_data_url(value: str) -> bytes:
    if "," in value:
        _, value = value.split(",", 1)
    try:
        return base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError("imageBase64 값을 디코딩하지 못했습니다.") from exc


def call_azure_image_analysis(endpoint: str, key: str, image_bytes: bytes) -> dict[str, Any]:
    url = f"{endpoint}/computervision/imageanalysis:analyze"
    response = requests.post(
        url,
        params={
            "api-version": "2024-02-01",
            "features": "objects,denseCaptions",
        },
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/octet-stream",
        },
        data=image_bytes,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def map_azure_objects(result: dict[str, Any], width: int | None, height: int | None) -> list[dict[str, Any]]:
    objects = []
    values = result.get("objectsResult", {}).get("values", [])
    for item in values:
        box = normalize_box(item.get("boundingBox") or {}, width, height)
        tags = item.get("tags") or []
        if not box or not tags:
            continue
        best = max(tags, key=lambda tag: tag.get("confidence", 0))
        objects.append(
            {
                "label": best.get("name", "object"),
                "score": float(best.get("confidence", 0)),
                "box": box,
            }
        )
    return objects


def map_azure_dense_captions(result: dict[str, Any], width: int | None, height: int | None) -> list[dict[str, Any]]:
    captions = []
    values = result.get("denseCaptionsResult", {}).get("values", [])
    for item in values:
        box = normalize_box(item.get("boundingBox") or {}, width, height)
        if not box:
            continue
        captions.append(
            {
                "text": item.get("text", ""),
                "score": float(item.get("confidence", 0)),
                "box": box,
            }
        )
    return captions


def normalize_box(box: dict[str, Any], width: int | None, height: int | None) -> dict[str, float] | None:
    x = box.get("x")
    y = box.get("y")
    w = box.get("w")
    h = box.get("h")
    if x is None or y is None or w is None or h is None:
        return None
    image_width = max(float(width or 1), 1.0)
    image_height = max(float(height or 1), 1.0)
    return {
        "xmin": max(0.0, min(1.0, float(x) / image_width)),
        "ymin": max(0.0, min(1.0, float(y) / image_height)),
        "xmax": max(0.0, min(1.0, (float(x) + float(w)) / image_width)),
        "ymax": max(0.0, min(1.0, (float(y) + float(h)) / image_height)),
    }
