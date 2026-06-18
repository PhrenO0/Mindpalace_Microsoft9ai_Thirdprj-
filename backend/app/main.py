from __future__ import annotations

import base64
import json
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

from . import sketchfab as sk

app = FastAPI(title="Mind Palace API", version="0.1.0")
ROOT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
LEGACY_PUBLIC_DIR = ROOT_DIR / "frontend" / "public" / "legacy"
LEGACY_DIST_DIR = FRONTEND_DIST / "legacy"
LEGACY_DIR = LEGACY_PUBLIC_DIR if LEGACY_PUBLIC_DIR.exists() else LEGACY_DIST_DIR
# Sketchfab 가져오기·스캔 결과가 저장되는 곳. /legacy 정적 마운트 아래라 자동 서빙되고,
# 스캐너·memory-walk가 상대경로(public/imported/...)로 그대로 읽는다.
IMPORTED_DIR = LEGACY_DIR / "public" / "imported"

# 로컬 개발 편의: 프로젝트 루트의 .env가 있으면 환경변수로 읽는다(없으면 무시 — Azure는 앱 설정 사용).
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
except Exception:
    pass

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
        "sketchfabConfigured": bool(sk.token()),
        "blobStorageConfigured": bool(os.getenv("AZURE_STORAGE_CONNECTION_STRING")),
    }


class SketchfabImportRequest(BaseModel):
    uid: str


class HotspotsSaveRequest(BaseModel):
    uid: str
    name: str | None = None
    hotspots: list[dict]


@app.get("/api/sketchfab/search")
def sketchfab_search(q: str, cursor: str | None = None) -> dict:
    """다운로드 가능한 Sketchfab 모델 검색(프록시). 토큰 없이도 결과는 보임(가져오기엔 토큰 필요)."""
    q = (q or "").strip()
    if not q:
        return {"results": [], "next": None}
    try:
        return sk.search(q, cursor)
    except requests.HTTPError as exc:
        detail = exc.response.text[:400] if exc.response is not None else str(exc)
        raise HTTPException(status_code=502, detail=f"Sketchfab 검색 실패: {detail}") from exc


@app.post("/api/sketchfab/import")
def sketchfab_import(payload: SketchfabImportRequest) -> dict:
    """모델을 받아 단일 GLB(텍스처 1k, 20MB 초과 시 압축)로 변환해 저장하고 상대 URL을 반환."""
    if not sk.token():
        raise HTTPException(status_code=503, detail="SKETCHFAB_API_TOKEN이 설정되지 않아 다운로드할 수 없습니다.")
    try:
        info = sk.import_model(payload.uid, IMPORTED_DIR)
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ModuleNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"변환 라이브러리가 설치되지 않았습니다({exc.name}). requirements.txt 설치 후 다시 시도하세요.",
        ) from exc
    except requests.HTTPError as exc:
        detail = exc.response.text[:400] if exc.response is not None else str(exc)
        raise HTTPException(status_code=502, detail=f"Sketchfab 다운로드 실패: {detail}") from exc
    # Blob 업로드 성공 시 blobUrl을 glbUrl로 사용. 폴백(로컬)이면 상대 경로.
    blob_url = info.pop("blobUrl", None)
    if blob_url:
        return {"glbUrl": blob_url, "absUrl": blob_url, **info}
    rel = f"public/imported/{payload.uid}.glb"
    return {"glbUrl": rel, "absUrl": f"/legacy/{rel}", **info}


@app.post("/api/rooms/hotspots")
def rooms_hotspots(payload: HotspotsSaveRequest) -> dict:
    """스캐너가 만든 노드(핫스팟)를 memory-walk가 fetch할 JSON으로 저장."""
    rel = sk.save_hotspots(payload.uid, payload.name, payload.hotspots, IMPORTED_DIR)
    return {"hotspotsUrl": rel}


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
        # 단일 진입점 통합: 루트(/)를 랜딩(home.html: PDF 업로드 → GraphRAG → 도시 선택 → 방)으로 리다이렉트.
        #   기존 Mind Palace SPA(dist)는 보존되며 직접 경로로는 접근 가능하나, 진입은 home으로 일원화.
        return RedirectResponse("/legacy/home.html")

    @app.get("/{path:path}")
    def serve_frontend_path(path: str) -> FileResponse:
        target = FRONTEND_DIST / path
        if target.is_file():
            return FileResponse(target)
        return FileResponse(FRONTEND_DIST / "index.html")
elif LEGACY_DIR.exists():

    @app.get("/")
    def serve_legacy_entry() -> RedirectResponse:
        return RedirectResponse("/legacy/home.html")


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
