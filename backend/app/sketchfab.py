"""Sketchfab 검색·가져오기(다운로드→GLB 변환→1k 텍스처→20MB 압축).

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
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import requests

SEARCH_URL = "https://api.sketchfab.com/v3/search"
DOWNLOAD_URL = "https://api.sketchfab.com/v3/models/{uid}/download"
MAX_BYTES_DEFAULT = 20 * 1024 * 1024  # 20MB — 이 이상이면 압축 발동


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


def _downscale_textures(scene, cap: int) -> None:
    """씬의 모든 재질 텍스처(PIL Image)를 긴 변 기준 cap 이하로 줄인다.
    텍스처가 용량의 대부분이라 1k(또는 더 작게) 다운스케일이 가장 큰 압축 효과."""
    from PIL import Image  # 지연 로드

    def shrink(img):
        try:
            if img is None or not hasattr(img, "size"):
                return img
            w, h = img.size
            if max(w, h) <= cap:
                return img
            scale = cap / float(max(w, h))
            return img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        except Exception:
            return img

    geometries = getattr(scene, "geometry", None) or {}
    for geom in geometries.values():
        visual = getattr(geom, "visual", None)
        material = getattr(visual, "material", None)
        if material is None:
            continue
        # PBRMaterial(여러 텍스처 슬롯) / SimpleMaterial(image) 모두 처리.
        for attr in ("baseColorTexture", "emissiveTexture", "metallicRoughnessTexture",
                     "normalTexture", "occlusionTexture", "image"):
            if hasattr(material, attr):
                try:
                    setattr(material, attr, shrink(getattr(material, attr)))
                except Exception:
                    pass


def import_model(uid: str, out_dir: Path, max_bytes: int = MAX_BYTES_DEFAULT) -> dict[str, Any]:
    """모델을 받아 단일 GLB(텍스처 ≤1k, 필요시 추가 압축)로 변환해 out_dir/<uid>.glb 에 저장.

    반환: {originalMB, finalMB, compressed, vertices}
    """
    import trimesh  # 지연 로드(검색 경로엔 불필요)

    url, _declared = _fetch_gltf_download_url(uid)
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    zip_bytes = resp.content
    original_mb = round(len(zip_bytes) / 1_000_000, 2)

    tmp = Path(tempfile.mkdtemp(prefix="sk_"))
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(tmp)
        model_path = _find_model_file(tmp)

        scene = trimesh.load(model_path, force="scene")

        # 1차: 항상 텍스처를 1k로 정리("1k 파일만" 요건).
        cap = 1024
        _downscale_textures(scene, cap)
        glb = scene.export(file_type="glb")

        # 2차: 그래도 20MB를 넘으면 텍스처를 절반씩 줄여 압축(바닥 256px).
        compressed = False
        while len(glb) > max_bytes and cap > 256:
            cap //= 2
            compressed = True
            _downscale_textures(scene, cap)
            glb = scene.export(file_type="glb")

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{uid}.glb"
        out_path.write_bytes(glb)

        return {
            "originalMB": original_mb,
            "finalMB": round(len(glb) / 1_000_000, 2),
            "compressed": compressed,
            "textureCap": cap,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def save_hotspots(uid: str, name: str | None, hotspots: list[dict], out_dir: Path) -> str:
    """스캐너가 만든 핫스팟(노드)을 memory-walk가 fetch할 수 있는 JSON으로 저장.
    반환: /legacy 기준 상대 경로(예: public/imported/<uid>-hotspots.json)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "roomId": uid,
        "title": name or uid,
        "generatedBy": "personal-room-scanner-3d (Sketchfab import flow)",
        "hotspots": hotspots,
    }
    path = out_dir / f"{uid}-hotspots.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"public/imported/{uid}-hotspots.json"
