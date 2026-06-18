"""사용자별 "내 서재" 저장소 — Azure Blob Storage 기반.

저장 대상: 한 학습 세션 = { palace(학습 내용) + designs(방/맵 구성) }. GLB·핫스팟은
이미 sketchfab.py가 Blob에 올리므로 여기선 palace+구성 JSON만 다룬다.

레이아웃(기존 GLB와 같은 "models" 컨테이너 재사용 → 새 컨테이너 생성 불필요):
    models/library/users/<userId>/items/<itemId>.json   # 전체 항목(palace 포함)
    models/library/users/<userId>/index.json            # 목록용 메타(제목·날짜)

userId 는 Easy Auth 가 넘기는 이메일(X-MS-CLIENT-PRINCIPAL-NAME). 로그인 전이거나
헤더가 없으면 "anonymous" 로 떨어진다(저장은 되되 공유는 안 됨).

Blob 미설정(AZURE_STORAGE_CONNECTION_STRING 없음)이면 모든 함수가 None/빈 결과를
반환하고, 라우터가 503 으로 안내한다.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("mindpalace.storage")

CONTAINER = "models"  # sketchfab GLB 와 같은 컨테이너 재사용(이미 존재).
PREFIX = "library/users"

# BlobServiceClient 는 생성 비용이 있어 프로세스 1회 생성 후 재사용(스레드 안전).
_blob_service_singleton = None
_blob_service_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def configured() -> bool:
    return bool((os.getenv("AZURE_STORAGE_CONNECTION_STRING") or "").strip())


def _blob_service():
    """BlobServiceClient 를 프로세스 1회 생성·재사용. 미설정/오류 시 None."""
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


def _container_client():
    """models 컨테이너 클라이언트. 미설정/오류 시 None."""
    svc = _blob_service()
    if svc is None:
        return None
    try:
        return svc.get_container_client(CONTAINER)
    except Exception:
        log.warning("컨테이너 클라이언트 생성 실패", exc_info=True)
        return None


def _safe_user(user_id: str) -> str:
    """이메일 등을 Blob 경로에 안전한 슬러그로. 충돌 방지를 위해 원형에 가깝게 둔다."""
    uid = (user_id or "anonymous").strip().lower()
    uid = re.sub(r"[^a-z0-9._@-]", "_", uid)
    return uid or "anonymous"


def _safe_id(item_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", item_id or "")


def _item_blob(user_id: str, item_id: str) -> str:
    return f"{PREFIX}/{_safe_user(user_id)}/items/{_safe_id(item_id)}.json"


def _index_blob(user_id: str) -> str:
    return f"{PREFIX}/{_safe_user(user_id)}/index.json"


def _read_json(container, blob_name: str) -> Any | None:
    try:
        data = container.download_blob(blob_name).readall()
        return json.loads(data.decode("utf-8"))
    except Exception as exc:
        # 없는 blob 은 정상(첫 저장 전 등) → 조용히 None. 그 외(권한·손상 등)는 경고.
        if exc.__class__.__name__ != "ResourceNotFoundError":
            log.warning("blob 읽기 실패: %s", blob_name, exc_info=True)
        return None


def _write_json(container, blob_name: str, obj: Any) -> None:
    from azure.storage.blob import ContentSettings

    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    container.upload_blob(
        blob_name,
        data,
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )


# 같은 사용자의 index.json 은 read-modify-write 라 동시 저장/삭제 시 한쪽 갱신이
# 유실될 수 있다 → 사용자별 락으로 직렬화한다.
# 주의: 프로세스 내 락이라 단일 인스턴스에서만 안전. 멀티 인스턴스로 확장하면
#       blob ETag(If-Match) 기반 낙관적 동시성으로 바꿔야 한다.
_index_locks: dict[str, threading.Lock] = {}
_index_locks_guard = threading.Lock()


def _index_lock(user_id: str) -> threading.Lock:
    key = _safe_user(user_id)
    with _index_locks_guard:
        lock = _index_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _index_locks[key] = lock
        return lock


def list_items(user_id: str) -> list[dict]:
    """목록용 메타 배열(최신순). 없으면 빈 배열."""
    container = _container_client()
    if container is None:
        return []
    index = _read_json(container, _index_blob(user_id)) or {}
    items = index.get("items") or []
    items.sort(key=lambda x: x.get("savedAt", ""), reverse=True)
    return items


def get_item(user_id: str, item_id: str) -> dict | None:
    """전체 항목(palace 포함). 없으면 None."""
    container = _container_client()
    if container is None:
        return None
    return _read_json(container, _item_blob(user_id, item_id))


def save_item(
    user_id: str,
    title: str,
    palace: Any,
    designs: Any = None,
    item_id: str | None = None,
) -> dict | None:
    """항목을 저장(없으면 새로, 있으면 덮어씀)하고 index 를 갱신. 메타 항목을 반환.
    Blob 미설정이면 None."""
    container = _container_client()
    if container is None:
        return None

    iid = _safe_id(item_id) if item_id else uuid.uuid4().hex
    saved_at = _now()
    safe_title = (title or "제목 없음").strip()[:200]

    item = {
        "id": iid,
        "title": safe_title,
        "savedAt": saved_at,
        "palace": palace,
        "designs": designs,
    }
    entry = {"id": iid, "title": safe_title, "savedAt": saved_at}
    with _index_lock(user_id):
        _write_json(container, _item_blob(user_id, iid), item)

        # index upsert(같은 id 있으면 교체).
        index = _read_json(container, _index_blob(user_id)) or {"items": []}
        index["items"] = [e for e in index.get("items", []) if e.get("id") != iid]
        index["items"].append(entry)
        _write_json(container, _index_blob(user_id), index)
    return entry


def delete_item(user_id: str, item_id: str) -> bool:
    """항목 + index 엔트리 삭제. 삭제했으면 True."""
    container = _container_client()
    if container is None:
        return False
    iid = _safe_id(item_id)
    with _index_lock(user_id):
        try:
            container.delete_blob(_item_blob(user_id, iid))
        except Exception:
            log.warning("항목 blob 삭제 실패: %s", iid, exc_info=True)
        index = _read_json(container, _index_blob(user_id)) or {"items": []}
        before = len(index.get("items", []))
        index["items"] = [e for e in index.get("items", []) if e.get("id") != iid]
        _write_json(container, _index_blob(user_id), index)
        return len(index["items"]) < before
