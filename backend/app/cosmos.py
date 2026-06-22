"""사용자/서재 메타데이터 — Azure Cosmos DB(NoSQL) 기반.

역할 분담(하이브리드):
    - cosmos.py : 작고 쿼리 대상인 메타 — 사용자 프로필 + 서재 항목 메타(+ 포인터).
    - storage.py: 무거운 payload(palace/designs JSON)를 Azure Blob 에 둔다(2MB 문서 한도 회피).

컨테이너(없으면 첫 사용 시 자동 생성):
    users   (pk /id)      : 프로필 1건 = 사용자 1명. id = 이메일(Easy Auth 신원).
    library (pk /userId)  : 항목 메타 1건 = 저장 1건. userId = users.id.

식별 키는 이메일이다(기존 Blob 경로·require_login 과 일치). Entra(Microsoft) 전환 대비로
oid(Entra object id)는 프로필 속성에 함께 보관해 둔다 — 추후 키를 oid 로 옮길 수 있게.

설정(둘 중 하나):
    AZURE_COSMOS_CONNECTION_STRING            # 권장(연결 문자열 하나)
    또는 AZURE_COSMOS_ENDPOINT + AZURE_COSMOS_KEY
선택:
    AZURE_COSMOS_DB_NAME      (기본 "mindpalace")
    AZURE_COSMOS_MAX_RU       (기본 1000 — 프로비저닝 오토스케일 상한 RU/s)
    AZURE_COSMOS_SERVERLESS   (true 면 처리량 미지정 — 서버리스 계정용)

미설정이면 configured()=False, 모든 함수가 None/빈 결과를 반환하고 라우터가 503 으로 안내한다.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("mindpalace.cosmos")

DB_NAME = os.getenv("AZURE_COSMOS_DB_NAME", "mindpalace")
USERS = "users"
LIBRARY = "library"
MNEMONICS = "mnemonics"
# graphrag 워커가 분석 1건마다 쓰는 컨테이너(같은 DB). 우리는 읽기만 한다.
#   doc id = "{jobId}:analysis", pk /jobId, 필드 total_tokens·total_cost_usd·calls·by_model.
USAGE = "usage"
# 사용자별 누적 토큰(우리가 쓰는 컨테이너). 분석은 jobId 멱등 집계, 대화는 질의마다 누적.
USER_USAGE = "user_usage"

# 클라이언트·컨테이너는 한 번만 만들어 캐시(매 요청 재연결 방지).
_client = None
_containers: dict[str, Any] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def configured() -> bool:
    if (os.getenv("AZURE_COSMOS_CONNECTION_STRING") or "").strip():
        return True
    return bool(
        (os.getenv("AZURE_COSMOS_ENDPOINT") or "").strip()
        and (os.getenv("AZURE_COSMOS_KEY") or "").strip()
    )


def _get_client():
    """CosmosClient(캐시). 미설정/오류/SDK 미설치 시 None."""
    global _client
    if _client is not None:
        return _client
    try:
        from azure.cosmos import CosmosClient

        conn = (os.getenv("AZURE_COSMOS_CONNECTION_STRING") or "").strip()
        if conn:
            _client = CosmosClient.from_connection_string(conn)
        else:
            endpoint = (os.getenv("AZURE_COSMOS_ENDPOINT") or "").strip()
            key = (os.getenv("AZURE_COSMOS_KEY") or "").strip()
            if not (endpoint and key):
                return None
            _client = CosmosClient(endpoint, credential=key)
        return _client
    except Exception:
        log.warning("Cosmos 클라이언트 초기화 실패", exc_info=True)
        return None


def _ensure_database(client):
    """DB 생성/확보. 프로비저닝 계정이면 DB 레벨 오토스케일 처리량을 공유로 두어
    컨테이너마다 처리량을 따로 잡지 않게 한다. 서버리스면 처리량을 지정하지 않는다."""
    serverless = (os.getenv("AZURE_COSMOS_SERVERLESS") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if serverless:
        return client.create_database_if_not_exists(DB_NAME)
    try:
        from azure.cosmos import ThroughputProperties

        max_ru = int(os.getenv("AZURE_COSMOS_MAX_RU", "1000"))
        return client.create_database_if_not_exists(
            DB_NAME,
            offer_throughput=ThroughputProperties(auto_scale_max_throughput=max_ru),
        )
    except Exception:
        # 서버리스 계정이 처리량을 거부하거나 이미 다른 모드로 존재하는 경우 등 → 처리량 없이.
        return client.create_database_if_not_exists(DB_NAME)


def _container(name: str, partition_key_path: str):
    """컨테이너 클라이언트(없으면 생성, 캐시). 미설정/오류 시 None."""
    if name in _containers:
        return _containers[name]
    client = _get_client()
    if client is None:
        return None
    try:
        from azure.cosmos import PartitionKey

        db = _ensure_database(client)
        cont = db.create_container_if_not_exists(
            id=name, partition_key=PartitionKey(path=partition_key_path)
        )
        _containers[name] = cont
        return cont
    except Exception:
        log.warning("Cosmos 컨테이너 확보 실패: %s", name, exc_info=True)
        return None


def _users():
    return _container(USERS, "/id")


def _library():
    return _container(LIBRARY, "/userId")


def _mnemonics():
    return _container(MNEMONICS, "/userId")


def _usage():
    # graphrag 가 만든 컨테이너(pk /jobId)와 동일한 파티션 키로 확보(있으면 그대로 사용).
    return _container(USAGE, "/jobId")


def _user_usage():
    return _container(USER_USAGE, "/userId")


# ── 사용자 프로필 ──────────────────────────────────────────────────────────

def upsert_user(
    email: str,
    display_name: str | None = None,
    oid: str | None = None,
    provider: str = "microsoft",
) -> dict | None:
    """로그인 시 호출. 없으면 생성, 있으면 lastLoginAt/표시정보 갱신. 미설정이면 None.

    멱등(idempotent)이라 매 로그인 호출해도 안전하다. createdAt 은 최초 1회만 박힌다."""
    cont = _users()
    if cont is None:
        return None
    now = _now()
    try:
        existing = None
        try:
            existing = cont.read_item(item=email, partition_key=email)
        except Exception:
            existing = None  # 없거나 접근 실패 → 신규로 취급.

        doc = existing or {
            "id": email,
            "email": email,
            "provider": provider,
            "createdAt": now,
        }
        # 표시 정보는 들어온 값이 있을 때만 갱신(빈 값으로 덮어쓰지 않음).
        if display_name:
            doc["displayName"] = display_name
        if oid:
            doc["oid"] = oid
        doc["provider"] = provider or doc.get("provider") or "microsoft"
        doc["lastLoginAt"] = now
        doc.setdefault("avatarUrl", "")  # Entra 는 사진 클레임 미제공 → 기본 빈 값.
        cont.upsert_item(doc)
        return doc
    except Exception:
        log.warning("사용자 upsert 실패: %s", email, exc_info=True)
        return None


def get_user(email: str) -> dict | None:
    cont = _users()
    if cont is None:
        return None
    try:
        return cont.read_item(item=email, partition_key=email)
    except Exception:
        return None


# ── 서재 항목 메타 ──────────────────────────────────────────────────────────

def list_item_metas(user_id: str) -> list[dict]:
    """해당 사용자 항목 메타 배열(최신순). 단일 파티션 쿼리라 저렴. 미설정/없으면 빈 배열."""
    cont = _library()
    if cont is None:
        return []
    try:
        items = list(
            cont.query_items(
                query="SELECT * FROM c WHERE c.userId=@u",
                parameters=[{"name": "@u", "value": user_id}],
                partition_key=user_id,
            )
        )
        items.sort(key=lambda x: x.get("savedAt", ""), reverse=True)
        return items
    except Exception:
        log.warning("서재 목록 조회 실패: %s", user_id, exc_info=True)
        return []


def get_item_meta(user_id: str, item_id: str) -> dict | None:
    cont = _library()
    if cont is None:
        return None
    try:
        return cont.read_item(item=item_id, partition_key=user_id)
    except Exception:
        return None


def upsert_item_meta(meta: dict) -> dict | None:
    cont = _library()
    if cont is None:
        return None
    try:
        return cont.upsert_item(meta)
    except Exception:
        log.warning("서재 메타 저장 실패: %s", meta.get("id"), exc_info=True)
        return None


def delete_item_meta(user_id: str, item_id: str) -> bool:
    cont = _library()
    if cont is None:
        return False
    try:
        cont.delete_item(item=item_id, partition_key=user_id)
        return True
    except Exception:
        return False


# ── 의미부여(mnemonic) — 생성 즉시 저장. 텍스트가 작아 Cosmos 인라인(Blob 불필요). ──

def _mnemo_id(palace_id: str, spot: str, entity: str) -> str:
    """palaceId:spot:entity 로 안정적(멱등) 문서 id. Cosmos 금지문자(/\\?#) 제거, 길이 제한."""
    raw = f"{palace_id or '_'}:{spot or '_'}:{entity or '_'}"
    return re.sub(r"[/\\?#]", "_", raw)[:200]


def upsert_mnemonic(
    user_id: str, palace_id: str, spot: str, entity: str, markdown: str
) -> dict | None:
    """의미부여 1건 upsert(덮어쓰기). 같은 (palace,spot,entity)면 같은 id → 재생성 시 갱신.
    멱등이라 생성 직후 매번 호출해도 안전. createdAt 은 최초 1회만."""
    cont = _mnemonics()
    if cont is None:
        return None
    mid = _mnemo_id(palace_id, spot, entity)
    now = _now()
    try:
        existing = None
        try:
            existing = cont.read_item(item=mid, partition_key=user_id)
        except Exception:
            existing = None
        doc = existing or {"id": mid, "userId": user_id, "createdAt": now}
        doc.update(
            {
                "palaceId": palace_id or "",
                "spot": spot or "",
                "entity": entity or "",
                "markdown": markdown or "",
                "updatedAt": now,
            }
        )
        cont.upsert_item(doc)
        return doc
    except Exception:
        log.warning("의미부여 upsert 실패: %s", mid, exc_info=True)
        return None


def list_mnemonics(user_id: str, palace_id: str | None = None) -> list[dict]:
    """사용자 의미부여 목록(단일 파티션 쿼리). palace_id 주면 그 궁전 것만."""
    cont = _mnemonics()
    if cont is None:
        return []
    try:
        if palace_id:
            q = "SELECT * FROM c WHERE c.userId=@u AND c.palaceId=@p"
            params = [
                {"name": "@u", "value": user_id},
                {"name": "@p", "value": palace_id},
            ]
        else:
            q = "SELECT * FROM c WHERE c.userId=@u"
            params = [{"name": "@u", "value": user_id}]
        return list(cont.query_items(query=q, parameters=params, partition_key=user_id))
    except Exception:
        log.warning("의미부여 목록 조회 실패: %s", user_id, exc_info=True)
        return []


def delete_mnemonic(user_id: str, palace_id: str, spot: str, entity: str) -> bool:
    cont = _mnemonics()
    if cont is None:
        return False
    try:
        cont.delete_item(item=_mnemo_id(palace_id, spot, entity), partition_key=user_id)
        return True
    except Exception:
        return False


# ── AI 토큰 사용량 — 분석(graphrag usage 읽기) + 대화(질의마다 누적). 표시는 토큰만($는 내부). ──

def get_analysis_usage(job_id: str) -> dict | None:
    """graphrag 가 쓴 분석 usage 문서를 읽는다(같은 DB의 usage 컨테이너). 없으면 None."""
    if not job_id:
        return None
    cont = _usage()
    if cont is None:
        return None
    try:
        return cont.read_item(item=f"{job_id}:analysis", partition_key=job_id)
    except Exception:
        return None


def _init_user_usage(user_id: str) -> dict:
    now = _now()
    return {
        "id": user_id,
        "userId": user_id,
        "analysisTokens": 0,
        "chatTokens": 0,
        "quizTokens": 0,
        "mnemonicTokens": 0,
        "analysisCostUsd": 0.0,  # 내부용($). 유저 표시는 토큰만.
        "chatCostUsd": 0.0,
        "quizCostUsd": 0.0,
        "mnemonicCostUsd": 0.0,
        "countedJobs": [],  # 분석 중복 집계 방지(멱등).
        "chatCount": 0,
        "quizCount": 0,
        "mnemonicCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }


def _read_user_usage(user_id: str) -> dict | None:
    cont = _user_usage()
    if cont is None:
        return None
    try:
        return cont.read_item(item=user_id, partition_key=user_id)
    except Exception:
        return None


def get_user_usage(user_id: str) -> dict:
    """이 사용자 누적 토큰(표시용 정규화). 문서 없으면 0. $ 는 노출하지 않는다.
    활동(activity) = 대화 + 퀴즈 + 의미부여 — 마이페이지는 분석/활동 2개로 보여준다."""
    doc = _read_user_usage(user_id) or {}
    a = int(doc.get("analysisTokens", 0) or 0)
    chat = int(doc.get("chatTokens", 0) or 0)
    quiz = int(doc.get("quizTokens", 0) or 0)
    mnem = int(doc.get("mnemonicTokens", 0) or 0)
    activity = chat + quiz + mnem
    return {
        "analysisTokens": a,
        "chatTokens": chat,
        "quizTokens": quiz,
        "mnemonicTokens": mnem,
        "activityTokens": activity,
        "totalTokens": a + activity,
    }


def track_analysis(user_id: str, job_id: str) -> dict | None:
    """분석 1건의 토큰을 이 사용자에 귀속(멱등 — 같은 jobId 는 한 번만 더한다).
    graphrag usage 문서가 아직 없으면 집계하지 않고 그대로 둔다(다음 호출에서 재시도 가능)."""
    if not (user_id and job_id):
        return None
    cont = _user_usage()
    if cont is None:
        return None
    try:
        doc = _read_user_usage(user_id) or _init_user_usage(user_id)
        if job_id in (doc.get("countedJobs") or []):
            return doc  # 이미 집계됨.
        a = get_analysis_usage(job_id)
        if not a:
            return doc  # usage 아직 안 쓰임 → 미집계로 둠.
        doc["analysisTokens"] = int(doc.get("analysisTokens", 0) or 0) + int(a.get("total_tokens", 0) or 0)
        doc["analysisCostUsd"] = round(
            float(doc.get("analysisCostUsd", 0.0) or 0.0) + float(a.get("total_cost_usd", 0.0) or 0.0), 6
        )
        doc.setdefault("countedJobs", []).append(job_id)
        doc["updatedAt"] = _now()
        cont.upsert_item(doc)
        return doc
    except Exception:
        log.warning("분석 토큰 집계 실패: user=%s job=%s", user_id, job_id, exc_info=True)
        return None


_EVENT_KINDS = ("chat", "quiz", "mnemonic")


def track_event(user_id: str, kind: str, tokens: int = 0, cost: float = 0.0) -> dict | None:
    """대화/퀴즈/의미부여 1건의 토큰을 해당 종류 필드에 누적. 활동마다 호출."""
    if not user_id or kind not in _EVENT_KINDS:
        return None
    cont = _user_usage()
    if cont is None:
        return None
    tk, ck, nk = kind + "Tokens", kind + "CostUsd", kind + "Count"
    try:
        doc = _read_user_usage(user_id) or _init_user_usage(user_id)
        doc[tk] = int(doc.get(tk, 0) or 0) + max(0, int(tokens or 0))
        doc[ck] = round(float(doc.get(ck, 0.0) or 0.0) + max(0.0, float(cost or 0.0)), 6)
        doc[nk] = int(doc.get(nk, 0) or 0) + 1
        doc["updatedAt"] = _now()
        cont.upsert_item(doc)
        return doc
    except Exception:
        log.warning("%s 토큰 집계 실패: user=%s", kind, user_id, exc_info=True)
        return None
