"""사용자별 "내 서재" 저장소 — Cosmos(메타) + Azure Blob(무거운 payload) 하이브리드.

저장 대상: 한 학습 세션 = { palace(학습 내용) + designs(방/맵 구성) }.

레이아웃:
    - 항목 메타(제목·날짜·방 개수·payload 포인터)는 Cosmos `library` 컨테이너(cosmos.py).
    - 무거운 palace/designs JSON 은 Blob 의 전용 "library" 컨테이너(3D GLB 의 "models" 와 분리):
        library: users/<userId>/items/<itemId>.palace.json
        library: users/<userId>/items/<itemId>.designs.json
      Cosmos 문서 1건 2MB 한도를 피하려고 payload 는 Blob 에 두고 메타엔 경로만 남긴다.
      컨테이너는 첫 사용 시 자동 생성. 이름은 LIBRARY_BLOB_CONTAINER 로 바꿀 수 있다(기본 library).
      계정은 AZURE_APP_STORAGE_CONNECTION_STRING(앱과 같은 리전 권장)을 쓰고, 없으면
      GLB 와 같은 AZURE_STORAGE_CONNECTION_STRING 을 재사용한다(단일 계정 setup 하위호환).
    - Blob 미설정이면 palace/designs 를 메타 문서에 인라인 저장(작은 궁전만 안전, 2MB 미만).

userId 는 Easy Auth 가 넘기는 이메일. 익명은 라우터(require_login)에서 401 로 막으므로 여기 도달하지 않는다.

저장의 원천(source of truth)은 Cosmos 다 → configured() 는 Cosmos 설정 여부를 본다.
Cosmos 미설정이면 모든 함수가 None/빈 결과를 반환하고 라우터가 503 으로 안내한다.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from . import cosmos

# 서재 payload 전용 컨테이너(3D GLB 의 "models" 와 분리). 첫 사용 시 자동 생성.
CONTAINER = os.getenv("LIBRARY_BLOB_CONTAINER", "library")
PREFIX = "users"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def configured() -> bool:
    """서재 기능 게이트 = Cosmos(메타 저장소) 설정 여부."""
    return cosmos.configured()


# ── Blob (무거운 payload) ────────────────────────────────────────────────────

_container_singleton = None


def _container_client():
    """서재 payload 컨테이너 클라이언트(캐시, 없으면 생성). 미설정/오류 시 None(→ payload 인라인 폴백)."""
    global _container_singleton
    if _container_singleton is not None:
        return _container_singleton
    # 서재 payload 전용 계정(앱과 같은 리전 권장). 없으면 GLB와 같은 계정 재사용(하위호환).
    conn = (
        os.getenv("AZURE_APP_STORAGE_CONNECTION_STRING")
        or os.getenv("AZURE_STORAGE_CONNECTION_STRING")
        or ""
    ).strip()
    if not conn:
        return None
    try:
        from azure.storage.blob import BlobServiceClient

        svc = BlobServiceClient.from_connection_string(conn)
        container = svc.get_container_client(CONTAINER)
        try:
            container.create_container()
        except Exception:
            pass  # 이미 있으면 무시.
        _container_singleton = container
        return container
    except Exception:
        return None


def _safe_user(user_id: str) -> str:
    """이메일 등을 Blob 경로에 안전한 슬러그로. 충돌 방지를 위해 원형에 가깝게 둔다."""
    uid = (user_id or "anonymous").strip().lower()
    uid = re.sub(r"[^a-z0-9._@-]", "_", uid)
    return uid or "anonymous"


def _safe_id(item_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", item_id or "")


def _palace_blob(user_id: str, item_id: str) -> str:
    return f"{PREFIX}/{_safe_user(user_id)}/items/{_safe_id(item_id)}.palace.json"


def _designs_blob(user_id: str, item_id: str) -> str:
    return f"{PREFIX}/{_safe_user(user_id)}/items/{_safe_id(item_id)}.designs.json"


def _edits_blob(user_id: str, item_id: str) -> str:
    return f"{PREFIX}/{_safe_user(user_id)}/items/{_safe_id(item_id)}.edits.json"


def _read_json(container, blob_name: str) -> Any | None:
    try:
        data = container.download_blob(blob_name).readall()
        return json.loads(data.decode("utf-8"))
    except Exception:
        return None  # 없거나 깨졌으면 None.


def _write_json(container, blob_name: str, obj: Any) -> None:
    from azure.storage.blob import ContentSettings

    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    container.upload_blob(
        blob_name,
        data,
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )


def _delete_blob(container, blob_name: str) -> None:
    try:
        container.delete_blob(blob_name)
    except Exception:
        pass  # 없으면 무시.


# ── 공개 API (라우터가 호출) ─────────────────────────────────────────────────

def list_items(user_id: str) -> list[dict]:
    """목록용 메타 배열(최신순). 없으면 빈 배열. mypage 는 {id,title,savedAt,rooms} 를 쓴다."""
    metas = cosmos.list_item_metas(user_id)
    return [
        {
            "id": m.get("id"),
            "title": m.get("title", "제목 없음"),
            "savedAt": m.get("savedAt", ""),
            "rooms": m.get("roomCount", 0),
        }
        for m in metas
    ]


def get_item(user_id: str, item_id: str) -> dict | None:
    """전체 항목(palace 포함). 없으면 None. payload 는 Blob 포인터면 Blob 에서 읽어 합친다."""
    meta = cosmos.get_item_meta(user_id, _safe_id(item_id))
    if meta is None:
        return None

    palace = meta.get("palace")  # 인라인 폴백으로 저장된 경우.
    designs = meta.get("designs")
    edits = meta.get("edits")

    container = _container_client()
    if container is not None:
        if palace is None and meta.get("palaceBlobPath"):
            palace = _read_json(container, meta["palaceBlobPath"])
        if designs is None and meta.get("designsBlobPath"):
            designs = _read_json(container, meta["designsBlobPath"])
        if edits is None and meta.get("editsBlobPath"):
            edits = _read_json(container, meta["editsBlobPath"])

    return {
        "id": meta.get("id"),
        "title": meta.get("title", "제목 없음"),
        "savedAt": meta.get("savedAt", ""),
        "palace": palace,
        "designs": designs,
        "edits": edits,
    }


def save_item(
    user_id: str,
    title: str,
    palace: Any,
    designs: Any = None,
    item_id: str | None = None,
    edits: Any = None,
) -> dict | None:
    """항목을 저장(없으면 새로, 있으면 덮어씀). 무거운 payload 는 Blob, 메타는 Cosmos.
    한 세션 = { palace + designs + edits(노드 순서/추가 오버레이) }.
    (의미부여는 별도 mnemonics 컨테이너에 생성 즉시 저장 — 이 번들엔 포함하지 않는다.)
    목록용 메타 항목을 반환. Cosmos 미설정이면 None."""
    if not cosmos.configured():
        return None

    iid = _safe_id(item_id) if item_id else uuid.uuid4().hex
    saved_at = _now()
    safe_title = (title or "제목 없음").strip()[:200]

    # 목록 화면 통계용 방 개수(palace.rooms 길이). 못 읽으면 0.
    try:
        room_count = len((palace or {}).get("rooms") or [])
    except Exception:
        room_count = 0

    meta = {
        "id": iid,
        "userId": user_id,
        "title": safe_title,
        "roomCount": room_count,
        "savedAt": saved_at,
        "updatedAt": saved_at,
    }

    # payload: Blob 가능하면 Blob, 아니면 메타에 인라인(작은 궁전용 폴백).
    container = _container_client()
    if container is not None:
        palace_path = _palace_blob(user_id, iid)
        _write_json(container, palace_path, palace)
        meta["palaceBlobPath"] = palace_path
        if designs is not None:
            designs_path = _designs_blob(user_id, iid)
            _write_json(container, designs_path, designs)
            meta["designsBlobPath"] = designs_path
        if edits is not None:
            edits_path = _edits_blob(user_id, iid)
            _write_json(container, edits_path, edits)
            meta["editsBlobPath"] = edits_path
    else:
        meta["palace"] = palace
        meta["designs"] = designs
        meta["edits"] = edits

    if cosmos.upsert_item_meta(meta) is None:
        return None
    return {"id": iid, "title": safe_title, "savedAt": saved_at, "rooms": room_count}


def delete_item(user_id: str, item_id: str) -> bool:
    """항목 메타 + Blob payload 삭제. 메타를 지웠으면 True."""
    iid = _safe_id(item_id)
    container = _container_client()
    if container is not None:
        _delete_blob(container, _palace_blob(user_id, iid))
        _delete_blob(container, _designs_blob(user_id, iid))
        _delete_blob(container, _edits_blob(user_id, iid))
    return cosmos.delete_item_meta(user_id, iid)
