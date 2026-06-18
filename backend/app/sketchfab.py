"""Sketchfab 검색·가져오기(다운로드→GLB 변환→1k 텍스처→20MB 압축→Azure Blob 업로드).

왜 백엔드인가:
  - 다운로드는 SKETCHFAB_API_TOKEN 인증이 필요(브라우저에 토큰 노출 방지).
  - Sketchfab "glTF" 다운로드는 단일 .glb가 아니라 zip(gltf+bin+texture)이라
    서버에서 해제 → 단일 .glb로 변환해야 스캐너(personal-room-scanner-3d)가 ?glb=로 바로 읽는다.
  - 텍스처 1k 다운스케일 / 20MB 초과 압축도 무거우니 서버에서.

무거운 의존(trimesh/Pillow)은 import_model 안에서 지연 로드한다 → 검색만 할 땐
패키지가 없어도(또는 미설치 상태여도) 동작하고 서버 기동이 느려지지 않는다.
"""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any

import requests

log = logging.getLogger("mindpalace.sketchfab")

SEARCH_URL = "https://api.sketchfab.com/v3/search"
DOWNLOAD_URL = "https://api.sketchfab.com/v3/models/{uid}/download"
MAX_BYTES_DEFAULT = 20 * 1024 * 1024  # 20MB — 이 이상이면 압축 발동

BLOB_CONTAINER = "models"
BLOB_IMPORTED_PREFIX = "imported"  # models/imported/<uid>.glb

# BlobServiceClient 는 생성 비용이 있어 프로세스 1회 생성 후 재사용(스레드 안전).
_blob_service_singleton = None
_blob_service_lock = threading.Lock()


def _blob_service_client():
    """AZURE_STORAGE_CONNECTION_STRING 으로 BlobServiceClient 반환(프로세스 1회 생성·재사용). 없으면 None."""
    global _blob_service_singleton
    conn = (os.getenv("AZURE_STORAGE_CONNECTION_STRING") or "").strip()
    if not conn:
        return None
    if _blob_service_singleton is not None:
        return _blob_service_singleton
    with _blob_service_lock:
        if _blob_service_singleton is None:
            try:
                from azure.storage.blob import BlobServiceClient
                _blob_service_singleton = BlobServiceClient.from_connection_string(conn)
            except Exception:
                log.warning("BlobServiceClient 생성 실패", exc_info=True)
                return None
    return _blob_service_singleton


def upload_to_blob(data: bytes, blob_name: str, content_type: str = "application/octet-stream") -> str | None:
    """bytes를 Azure Blob에 올리고 공개 URL을 반환. 실패하거나 미설정이면 None."""
    client = _blob_service_client()
    if client is None:
        return None
    try:
        blob_client = client.get_blob_client(container=BLOB_CONTAINER, blob=blob_name)
        from azure.storage.blob import ContentSettings
        blob_client.upload_blob(
            data,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )
        return blob_client.url
    except Exception:
        log.warning("Blob 업로드 실패: %s", blob_name, exc_info=True)
        return None


def token() -> str:
    return (os.getenv("SKETCHFAB_API_TOKEN") or os.getenv("SKETCHFAB_TOKEN") or "").strip()


def _auth_headers() -> dict[str, str]:
    t = token()
    return {"Authorization": f"Token {t}"} if t else {}


def search(q: str, cursor: str | None = None, count: int = 24) -> dict[str, Any]:
    """다운로드 가능한 모델만 검색(downloadable=true). 토큰 없이도 동작(있으면 함께 전송)."""
    params = {
        "type": "models",
        "q": q,
        "downloadable": "true",
        "count": count,
        # archives_flavours=false → 응답을 가볍게(아카이브 상세 제외).
        "archives_flavours": "false",
    }
    if cursor:
        params["cursor"] = cursor
    r = requests.get(SEARCH_URL, params=params, headers=_auth_headers(), timeout=20)
    r.raise_for_status()
    data = r.json()
    results = []
    for m in data.get("results", []):
        thumb, thumb_large = _pick_thumbs(m)
        results.append(
            {
                "uid": m.get("uid"),
                "name": m.get("name") or "Untitled",
                "thumb": thumb,
                "thumbLarge": thumb_large,
                "viewerUrl": m.get("viewerUrl") or f"https://sketchfab.com/models/{m.get('uid')}/embed",
                "isDownloadable": bool(m.get("isDownloadable", True)),
            }
        )
    cursors = data.get("cursors") or {}
    return {"results": results, "next": cursors.get("next")}


def _pick_thumbs(model: dict[str, Any]) -> tuple[str, str]:
    """(중간 썸네일, 큰 썸네일) — 그리드용 / 크게보기용."""
    images = ((model.get("thumbnails") or {}).get("images")) or []
    if not images:
        return "", ""
    images = sorted(images, key=lambda i: i.get("width", 0))
    mid = images[len(images) // 2].get("url", "") or images[-1].get("url", "")
    large = images[-1].get("url", "") or mid
    return mid, large


def _fetch_gltf_download_url(uid: str) -> tuple[str, int | None]:
    if not token():
        raise PermissionError("SKETCHFAB_API_TOKEN이 설정되지 않아 다운로드할 수 없습니다.")
    r = requests.get(DOWNLOAD_URL.format(uid=uid), headers=_auth_headers(), timeout=30)
    r.raise_for_status()
    j = r.json()
    gltf = j.get("gltf") or {}
    if not gltf.get("url"):
        raise ValueError("이 모델은 glTF 다운로드를 제공하지 않습니다(다른 모델을 선택하세요).")
    return gltf["url"], gltf.get("size")


def _find_model_file(root: Path) -> Path:
    """압축 해제 폴더에서 .gltf(우선) 또는 .glb를 찾는다."""
    gltfs = sorted(root.rglob("*.gltf"))
    if gltfs:
        return gltfs[0]
    glbs = sorted(root.rglob("*.glb"))
    if glbs:
        return glbs[0]
    raise ValueError("압축 안에서 glTF/GLB 파일을 찾지 못했습니다.")


_TEXTURE_ATTRS = (
    "baseColorTexture", "emissiveTexture", "metallicRoughnessTexture",
    "normalTexture", "occlusionTexture", "image",
)


def _collect_textures(scene) -> list[tuple[Any, str, Any]]:
    """씬의 모든 재질에서 (material, attr, 원본이미지) 를 1회만 수집한다.
    압축 루프가 매번 씬을 재순회하지 않도록 하고, 원본을 보관해 반복 축소 시 화질 열화를 막는다."""
    found: list[tuple[Any, str, Any]] = []
    geometries = getattr(scene, "geometry", None) or {}
    for geom in geometries.values():
        visual = getattr(geom, "visual", None)
        material = getattr(visual, "material", None)
        if material is None:
            continue
        # PBRMaterial(여러 텍스처 슬롯) / SimpleMaterial(image) 모두 처리.
        for attr in _TEXTURE_ATTRS:
            if hasattr(material, attr):
                img = getattr(material, attr)
                if img is not None and hasattr(img, "size"):
                    found.append((material, attr, img))
    return found


def _apply_texture_cap(textures: list[tuple[Any, str, Any]], cap: int) -> None:
    """수집된 텍스처를 항상 '원본' 기준으로 긴 변 cap 이하가 되게 줄여 적용한다.
    텍스처가 용량의 대부분이라 1k(또는 더 작게) 다운스케일이 가장 큰 압축 효과."""
    from PIL import Image  # 지연 로드

    for material, attr, original in textures:
        try:
            w, h = original.size
            if max(w, h) <= cap:
                setattr(material, attr, original)
                continue
            scale = cap / float(max(w, h))
            resized = original.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS
            )
            setattr(material, attr, resized)
        except Exception:
            log.debug("텍스처 다운스케일 실패: %s", attr, exc_info=True)


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    """zip slip 방어: 각 엔트리가 dest 밖으로 벗어나지 않는지 확인한 뒤 추출한다.
    (악의적 zip 의 '../' 경로로 임의 위치에 파일을 쓰는 것을 차단)."""
    dest = dest.resolve()
    for member in zf.namelist():
        target = (dest / member).resolve()
        if target != dest and dest not in target.parents:
            raise ValueError(f"안전하지 않은 zip 경로가 감지되었습니다: {member!r}")
    zf.extractall(dest)


# 같은 uid 를 동시에 가져오면 한 번만 다운로드·변환하도록 uid별 락으로 직렬화한다
# (두 번째 요청은 첫 번째가 올린 blob 을 그대로 재사용 → Sketchfab 쿼터 보호).
_import_locks: dict[str, threading.Lock] = {}
_import_locks_guard = threading.Lock()


def _import_lock(uid: str) -> threading.Lock:
    with _import_locks_guard:
        lock = _import_locks.get(uid)
        if lock is None:
            lock = threading.Lock()
            _import_locks[uid] = lock
        return lock


def _existing_blob_url(blob_name: str) -> str | None:
    """이미 변환·업로드된 GLB 가 있으면 그 URL 을 반환(중복 다운로드·변환 방지). 없으면 None."""
    client = _blob_service_client()
    if client is None:
        return None
    try:
        blob_client = client.get_blob_client(container=BLOB_CONTAINER, blob=blob_name)
        if blob_client.exists():
            return blob_client.url
    except Exception:
        log.debug("기존 blob 확인 실패: %s", blob_name, exc_info=True)
    return None


def import_model(uid: str, out_dir: Path, max_bytes: int = MAX_BYTES_DEFAULT) -> dict[str, Any]:
    """모델을 받아 단일 GLB(텍스처 ≤1k, 필요시 추가 압축)로 변환.
    Azure Blob Storage가 설정돼 있으면 models/imported/<uid>.glb 에 업로드하고 blob URL 반환.
    미설정이면 out_dir/<uid>.glb 에 로컬 저장.

    같은 uid 동시/반복 요청은 uid별 락으로 직렬화하고, 이미 올라간 blob 이 있으면
    재다운로드 없이 그 URL 을 돌려준다(중복 import 방어).

    반환: {originalMB, finalMB, compressed, textureCap, blobUrl(blob 업로드 시)}
          또는 캐시 히트 시 {cached: True, blobUrl}.
    """
    blob_name = f"{BLOB_IMPORTED_PREFIX}/{uid}.glb"
    with _import_lock(uid):
        cached = _existing_blob_url(blob_name)
        if cached:
            return {"cached": True, "blobUrl": cached}

        import trimesh  # 지연 로드(검색·캐시 경로엔 불필요)

        url, _declared = _fetch_gltf_download_url(uid)
        resp = requests.get(url, timeout=180)
        resp.raise_for_status()
        zip_bytes = resp.content
        original_mb = round(len(zip_bytes) / 1_000_000, 2)

        tmp = Path(tempfile.mkdtemp(prefix="sk_"))
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                _safe_extract(zf, tmp)
            model_path = _find_model_file(tmp)

            scene = trimesh.load(model_path, force="scene")
            textures = _collect_textures(scene)

            # 1차: 항상 텍스처를 1k로 정리("1k 파일만" 요건).
            cap = 1024
            _apply_texture_cap(textures, cap)
            glb = scene.export(file_type="glb")

            # 2차: 그래도 20MB를 넘으면 텍스처를 절반씩 줄여 압축(바닥 256px).
            compressed = False
            while len(glb) > max_bytes and cap > 256:
                cap //= 2
                compressed = True
                _apply_texture_cap(textures, cap)
                glb = scene.export(file_type="glb")

            result: dict[str, Any] = {
                "originalMB": original_mb,
                "finalMB": round(len(glb) / 1_000_000, 2),
                "compressed": compressed,
                "textureCap": cap,
            }

            # Blob Storage 업로드 시도. 성공하면 blobUrl 포함, 실패하면 로컬 저장으로 폴백.
            blob_url = upload_to_blob(glb, blob_name, content_type="model/gltf-binary")
            if blob_url:
                result["blobUrl"] = blob_url
            else:
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / f"{uid}.glb").write_bytes(glb)

            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def save_hotspots(uid: str, name: str | None, hotspots: list[dict], out_dir: Path) -> str:
    """스캐너가 만든 핫스팟(노드)을 memory-walk가 fetch할 수 있는 JSON으로 저장.
    Blob Storage 설정 시 models/imported/<uid>-hotspots.json 에 업로드하고 blob URL 반환.
    미설정 시 로컬 저장 후 상대 경로 반환."""
    data = {
        "roomId": uid,
        "title": name or uid,
        "generatedBy": "personal-room-scanner-3d (Sketchfab import flow)",
        "hotspots": hotspots,
    }
    json_bytes = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")

    blob_name = f"{BLOB_IMPORTED_PREFIX}/{uid}-hotspots.json"
    blob_url = upload_to_blob(json_bytes, blob_name, content_type="application/json")
    if blob_url:
        return blob_url

    # Blob 미설정 폴백: 로컬 저장
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{uid}-hotspots.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return f"public/imported/{uid}-hotspots.json"
