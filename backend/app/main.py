from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import requests
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import cosmos
from . import sketchfab as sk
from . import storage

log = logging.getLogger("mindpalace.api")

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

# 요청 본문 상한(기본 12MB). detect의 base64 이미지/거대한 palace JSON 등으로 메모리를
# 소모시키는 것을 1차 차단한다(Content-Length 기준 — 청크 전송은 핸들러 레벨 검증으로 보완).
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(12 * 1024 * 1024)))
# 사용자가 저장하는 palace/designs JSON 1건의 상한.
MAX_PALACE_BYTES = int(os.getenv("MAX_PALACE_BYTES", str(3 * 1024 * 1024)))


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"detail": "요청 본문이 너무 큽니다."})
    return await call_next(request)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """기본 보안 응답 헤더. CSP는 legacy의 인라인 스크립트·외부 지도/임베드 의존이 커서
    여기선 깨지지 않는 항목만 적용한다(엄격 CSP는 리소스 allowlist 설계 후 별도 단계)."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    # HTML·JS 는 매 배포마다 바뀌므로 브라우저가 옛 버전을 '신선'하다고 재사용하지 않게 항상 재검증(no-cache).
    # → 배포 후 새로고침만으로 최신 코드를 받는다(ETag로 안 바뀌면 304라 비용도 작음). GLB·이미지 등은 그대로 캐시.
    p = request.url.path.lower()
    if p.endswith(".html") or p.endswith(".js") or p.endswith("/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ── 간단한 인메모리 레이트리밋(고정 윈도) ──
# 외부 의존 없이 비용성 엔드포인트(import/detect/search/client-config)의 남용을 막는다.
# 주의: 프로세스 단위라 멀티 인스턴스/워커로 확장하면 Redis 등 공유 저장소가 필요하다.
_rate_buckets: dict[tuple[str, str], deque] = defaultdict(deque)
_rate_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(scope: str, limit: int, window_sec: float):
    """scope별·IP별로 window_sec 동안 limit회만 허용하는 의존성을 만든다."""
    def dependency(request: Request) -> None:
        key = (scope, _client_ip(request))
        now = time.monotonic()
        with _rate_lock:
            bucket = _rate_buckets[key]
            while bucket and now - bucket[0] > window_sec:
                bucket.popleft()
            if len(bucket) >= limit:
                raise HTTPException(
                    status_code=429,
                    detail="요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
                )
            bucket.append(now)
    return dependency


class DetectRequest(BaseModel):
    imageBase64: str = Field(max_length=18_000_000)  # base64 약 13MB(원본 ~10MB) 상한
    width: int | None = Field(default=None, ge=1, le=20000)
    height: int | None = Field(default=None, ge=1, le=20000)


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


def llm_chat_config() -> dict | None:
    """LLM chat completions 설정 — Azure OpenAI(우선) 또는 OpenAI. 미설정이면 None.
    Azure: AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY / AZURE_OPENAI_DEPLOYMENT [/ AZURE_OPENAI_API_VERSION]
    OpenAI: OPENAI_API_KEY [/ OPENAI_MODEL]"""
    az_ep = (os.getenv("AZURE_OPENAI_ENDPOINT") or "").strip().rstrip("/")
    az_key = (os.getenv("AZURE_OPENAI_KEY") or os.getenv("AZURE_OPENAI_API_KEY") or "").strip()
    az_dep = (os.getenv("AZURE_OPENAI_DEPLOYMENT") or os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME") or "").strip()
    if az_ep and az_key and az_dep:
        # 기본값을 gpt-4.1 계열까지 지원하는 최신 프리뷰로(구버전은 404 'Resource not found'). 필요시 env로 override.
        ver = (os.getenv("AZURE_OPENAI_API_VERSION") or "2025-01-01-preview").strip()
        return {
            "url": f"{az_ep}/openai/deployments/{az_dep}/chat/completions?api-version={ver}",
            "headers": {"api-key": az_key, "Content-Type": "application/json"},
            "model": None,
            "provider": "azure",
            "deployment": az_dep,
            "apiVersion": ver,
        }
    o_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if o_key:
        return {
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {"Authorization": f"Bearer {o_key}", "Content-Type": "application/json"},
            "model": (os.getenv("OPENAI_MODEL") or "gpt-4o-mini").strip(),
            "provider": "openai",
        }
    return None


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
        "cosmosConfigured": cosmos.configured(),
        "openaiConfigured": bool(llm_chat_config()),
    }


# 무거운 다운로드·변환(import_model)이 서버 워커 스레드풀을 고갈시키지 않도록
# 동시 import 수를 제한한다(기본 2, 환경변수로 조정 가능).
_IMPORT_CONCURRENCY = max(1, int(os.getenv("SKETCHFAB_IMPORT_CONCURRENCY", "2")))
_import_semaphore = asyncio.Semaphore(_IMPORT_CONCURRENCY)


class SketchfabImportRequest(BaseModel):
    # Sketchfab uid는 영숫자(보통 32자 hex). 패턴 고정으로 다운로드 URL 주입 여지를 차단.
    uid: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9]+$")


class HotspotsSaveRequest(BaseModel):
    uid: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9]+$")
    name: str | None = Field(default=None, max_length=200)
    hotspots: list[dict] = Field(max_length=1000)


@app.get(
    "/api/sketchfab/search",
    dependencies=[Depends(rate_limit("search", limit=30, window_sec=60))],
)
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


@app.post(
    "/api/sketchfab/import",
    dependencies=[Depends(rate_limit("import", limit=10, window_sec=60))],
)
async def sketchfab_import(payload: SketchfabImportRequest) -> dict:
    """모델을 받아 단일 GLB(텍스처 1k, 20MB 초과 시 압축)로 변환해 저장하고 상대 URL을 반환.

    무거운 변환 작업은 별도 스레드로 오프로드하고(이벤트 루프 비차단), 세마포어로 동시
    실행 수를 제한해 워커 스레드풀 고갈을 막는다."""
    if not sk.token():
        raise HTTPException(status_code=503, detail="SKETCHFAB_API_TOKEN이 설정되지 않아 다운로드할 수 없습니다.")
    try:
        async with _import_semaphore:
            info = await asyncio.to_thread(sk.import_model, payload.uid, IMPORTED_DIR)
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


@app.get(
    "/api/client-config",
    dependencies=[Depends(rate_limit("client-config", limit=60, window_sec=60))],
)
def client_config() -> dict:
    # 주의: vworld SDK가 브라우저에서 키를 직접 쓰므로(map.vworld.kr) 키는 본질적으로
    #       클라이언트에 노출된다. 이 엔드포인트의 레이트리밋은 대량 스크래핑만 늦출 뿐이며,
    #       실제 방어는 vworld 콘솔의 '도메인 제한'이다(README/배포 설정 참고).
    return {
        "vworldApiKey": os.getenv("VWORLD_API_KEY", ""),
    }


@app.get("/api/vision-config")
def vision_config() -> dict:
    endpoint, key = azure_vision_config()
    return {
        "azure": bool(endpoint and key),
    }


class RecommendCityRequest(BaseModel):
    corpus: str = Field(default="", max_length=20000)
    cities: list[dict] = Field(default_factory=list)


@app.post(
    "/api/recommend-city",
    dependencies=[Depends(rate_limit("recommend-city", limit=30, window_sec=60))],
)
def recommend_city(payload: RecommendCityRequest) -> dict:
    """업로드 학습 자료(corpus)에 가장 잘 맞는 도시를 LLM으로 추천.
    미설정/오류/모호하면 configured 또는 slug=None 으로 신호 → 클라이언트가 규칙기반으로 폴백한다."""
    cfg = llm_chat_config()
    if not cfg:
        return {"configured": False}
    cities = [
        {"slug": str(c.get("slug")), "name": str(c.get("name") or ""), "region": str(c.get("region") or "")}
        for c in (payload.cities or [])
        if isinstance(c, dict) and c.get("slug")
    ][:120]
    corpus = (payload.corpus or "")[:6000].strip()
    if not cities or not corpus:
        return {"configured": True, "slug": None}
    valid = {c["slug"] for c in cities}
    city_lines = "\n".join(f"- {c['slug']}: {c['name']} ({c['region']})" for c in cities)
    system = (
        "너는 한국 도시 추천 도우미다. 사용자의 학습 자료 주제·인물·사건·장소와 가장 잘 어울리는"
        "(연관 명소가 있는) 한국 도시 하나를 후보 목록에서 고른다. 반드시 후보의 slug 중 하나만 고르고 JSON으로만 답한다."
    )
    user = (
        f"학습 자료 발췌:\n{corpus}\n\n"
        f"후보 도시(slug: 이름(권역)):\n{city_lines}\n\n"
        '가장 잘 어울리는 도시 하나를 골라 JSON으로만 답하라: {"slug":"<후보 slug>","reason":"한 문장 이유"}'
    )
    body: dict[str, Any] = {
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
        "max_tokens": 200,
        "response_format": {"type": "json_object"},
    }
    if cfg.get("model"):
        body["model"] = cfg["model"]
    try:
        # 클라 타임아웃(8s)보다 약간 짧게 — 클라가 폴백한 뒤 워커가 헛돌지 않게.
        resp = requests.post(cfg["url"], headers=cfg["headers"], json=body, timeout=(4, 7))
    except requests.RequestException:
        log.warning("recommend-city LLM 요청 실패", exc_info=True)   # 내부 URL 등은 로그에만, 응답엔 미노출
        return {"configured": True, "slug": None, "error": "request"}
    if not resp.ok:
        # 진단용: 어떤 provider/배포에서 어떤 응답인지(설정 점검용). 본문 일부만.
        return {
            "configured": True, "slug": None, "error": f"llm {resp.status_code}",
            "provider": cfg.get("provider"), "deployment": cfg.get("deployment"),
            "apiVersion": cfg.get("apiVersion"), "model": cfg.get("model"),
            "detail": (resp.text or "")[:300],
        }
    try:
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        if not isinstance(parsed, dict):   # JSON이지만 객체가 아니면(배열·문자열 등) 폴백 신호
            return {"configured": True, "slug": None, "error": "parse"}
        slug = parsed.get("slug")
        reason = str(parsed.get("reason") or "")[:200]
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        return {"configured": True, "slug": None, "error": "parse"}
    if slug not in valid:  # LLM이 이름을 반환했을 때만, 정확히 일치하는 이름으로 재매칭(부분일치·빈이름 제외)
        slug = next((c["slug"] for c in cities if slug and c["name"] and slug == c["name"]), None)
    return {"configured": True, "slug": slug if slug in valid else None, "reason": reason}


@app.post(
    "/api/vision-label",
    dependencies=[Depends(rate_limit("vision-label", limit=30, window_sec=60))],
)
def vision_label(payload: DetectRequest) -> dict:
    """크롭한 사물 이미지를 멀티모달 LLM(gpt-4.1/4o 비전)에 보내 한국어 사물명을 받는다.
    핫스팟 '정밀' 인식용 — Azure Computer Vision의 고정 어휘보다 풍부·정확. 미설정/오류면 label=None."""
    cfg = llm_chat_config()
    if not cfg:
        return {"configured": False}
    img = (payload.imageBase64 or "").strip()
    if not img:
        return {"configured": True, "label": None}
    if not img.startswith("data:"):
        img = "data:image/png;base64," + img
    system = (
        "너는 실내 3D 장면 사진 속 사물을 인식하는 도우미다. 사진 중앙(또는 가장 크고 두드러진)"
        " 가구·사물의 종류를 한국어 한 단어(일반 명사)로만 답한다. 사람·텍스트·UI가 아니라 가구/소품을 본다."
    )
    user_text = (
        "이 사진에서 가장 두드러진 가구/사물의 종류는 무엇입니까? 한국어 한 단어로만"
        " (예: 의자, 소파, 식탁, 책상, 침대, 책장, 수납장, 화분, 조명, 그림, 러그, 창문, TV, 냉장고, 꽃병)."
        ' JSON으로만 답하라: {"label":"<종류>"}'
    )
    body: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": img}},
            ]},
        ],
        "temperature": 0.0,
        "max_tokens": 60,
        "response_format": {"type": "json_object"},
    }
    if cfg.get("model"):
        body["model"] = cfg["model"]
    try:
        resp = requests.post(cfg["url"], headers=cfg["headers"], json=body, timeout=(5, 22))
    except requests.RequestException:
        log.warning("vision-label LLM 요청 실패", exc_info=True)
        return {"configured": True, "label": None, "error": "request"}
    if not resp.ok:
        return {"configured": True, "label": None, "error": f"llm {resp.status_code}", "detail": (resp.text or "")[:200]}
    try:
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        label = str(parsed.get("label") or "").strip()[:40] if isinstance(parsed, dict) else ""
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        return {"configured": True, "label": None, "error": "parse"}
    return {"configured": True, "label": label or None}


@app.post(
    "/api/detect",
    dependencies=[Depends(rate_limit("detect", limit=20, window_sec=60))],
)
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


# ── 내 서재(라이브러리): palace + 방 구성을 사용자별 Azure Blob에 저장/불러오기 ──
# 정책: 서비스의 나머지 기능(궁전 체험·지도·스캐너·객체인식 등)은 익명으로 전부 사용 가능하지만,
#       '내 서재'(서버 저장/목록/불러오기/삭제)는 로그인 사용자 전용이다.
#       → 익명(로그인 신원 없음) 요청은 아래 require_login 의존성이 401로 막는다.
#         이렇게 하면 익명끼리 같은 'anonymous' 버킷을 공유하는 프라이버시 문제 자체가 사라진다.

# Easy Auth principal 클레임 중 사용자 식별에 쓸 타입들.
# 이메일/UPN(도메인 포함)을 먼저 잡고, 그게 전혀 없을 때만 이름으로 폴백한다.
# (학원 Entra 계정처럼 email 클레임이 없고 name=아이디인 경우라도
#  preferred_username 의 전체 UPN '아이디@도메인' 을 안정적 식별 키로 쓰기 위함.
#  과거엔 name 도 이 집합에 섞여 있어, 클레임 배열에서 name 이 preferred_username
#  보다 앞서 오면 도메인 없는 짧은 아이디가 키로 잡히는 문제가 있었다.)
_EMAIL_CLAIM_TYPES = {
    "emails",
    "email",
    "emailaddress",
    "preferred_username",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
}
# 이메일/UPN 클레임이 하나도 없을 때만 쓰는 폴백(이름).
_USERID_NAME_FALLBACK_TYPES = {
    "name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
}

# 표시 이름·Entra object id 클레임(프로필 기록용). Microsoft(AAD) 전환 대비.
_NAME_CLAIM_TYPES = {
    "name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
}
_OID_CLAIM_TYPES = {
    "oid",
    "http://schemas.microsoft.com/identity/claims/objectidentifier",
}


def _principal_claims(request: Request) -> list[dict]:
    """Easy Auth가 주입하는 서명된 principal(X-MS-CLIENT-PRINCIPAL, base64 JSON)에서
    claims 배열을 꺼낸다. 헤더 없음/디코드 실패 시 빈 배열."""
    raw = (request.headers.get("X-MS-CLIENT-PRINCIPAL") or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(base64.b64decode(raw))
    except Exception:
        log.warning("X-MS-CLIENT-PRINCIPAL 디코드 실패", exc_info=True)
        return []
    return data.get("claims") or []


def _principal_user_id(request: Request) -> str | None:
    """principal 클레임에서 안정적인 사용자 식별값을 추출. NAME 헤더보다 우선.
    이메일/UPN 클레임(도메인 포함)을 이름보다 우선해 잡는다 — 클레임 배열에서 name 이
    preferred_username 보다 앞서 와도 전체 UPN 을 식별 키로 쓰기 위함(짧은 아이디 키 방지)."""
    claims = _principal_claims(request)
    # 1순위: 이메일/UPN 클레임(전체 도메인 포함).
    for claim in claims:
        typ = (claim.get("typ") or "").lower()
        if typ in _EMAIL_CLAIM_TYPES or typ.endswith("/emailaddress"):
            val = (claim.get("val") or "").strip()
            if val:
                return val
    # 2순위(폴백): 이름 클레임. 이메일/UPN 클레임이 전혀 없을 때만.
    for claim in claims:
        typ = (claim.get("typ") or "").lower()
        if typ in _USERID_NAME_FALLBACK_TYPES or typ.endswith("/name"):
            val = (claim.get("val") or "").strip()
            if val:
                return val
    return None


def _principal_profile(request: Request) -> dict:
    """프로필 기록용 부가 정보 추출: {displayName, oid}. (이메일은 require_login 이 따로 구함.)"""
    display_name = None
    oid = None
    for claim in _principal_claims(request):
        typ = (claim.get("typ") or "").lower()
        val = (claim.get("val") or "").strip()
        if not val:
            continue
        if oid is None and (typ in _OID_CLAIM_TYPES or typ.endswith("/objectidentifier")):
            oid = val
        elif display_name is None and typ in _NAME_CLAIM_TYPES:
            display_name = val
    return {"displayName": display_name, "oid": oid}


def require_login(request: Request) -> str:
    """로그인 사용자 식별값을 반환. 익명(신원 헤더 없음)이면 401 → 서재 전용 게이트.
    우선순위: 서명된 principal 클레임 > NAME 헤더.

    부수효과: 로그인 사용자를 users 컨테이너에 기록(멱등 upsert). Cosmos 미설정이면 조용히 패스.
    (지금은 서재 호출마다 1회 point write — 비용 미미. Entra 인증 전환 단계에서 전용
     /api/me 훅으로 옮기는 게 더 깔끔하다.)

    경고: 이 헤더들의 '신뢰'는 App Service Easy Auth 와 컨테이너 직접 노출 차단에서
    나온다. Easy Auth(미인증 허용 모드)는 켜두되, 컨테이너가 외부에 직접 노출되지
    않도록 해야 클라이언트가 신원 헤더를 위조하지 못한다."""
    uid = _principal_user_id(request)
    if not uid:
        uid = (request.headers.get("X-MS-CLIENT-PRINCIPAL-NAME") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="로그인이 필요한 기능입니다.")
    if cosmos.configured():
        prof = _principal_profile(request)
        cosmos.upsert_user(uid, display_name=prof.get("displayName"), oid=prof.get("oid"))
    return uid


class LibrarySaveRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    palace: Any
    designs: Any | None = None
    edits: Any | None = None  # 노드 순서/추가 오버레이 { "mw_edit:<room>": {...}, ... }
    id: str | None = Field(default=None, max_length=64)
    # (의미부여는 별도 /api/mnemonic 으로 생성 즉시 저장 — 이 번들엔 없음)


def _reject_oversized_payload(*objects: Any) -> None:
    """palace/designs 직렬화 크기가 상한을 넘으면 413. 스토리지 남용을 막는다."""
    total = 0
    for obj in objects:
        if obj is None:
            continue
        try:
            total += len(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="저장할 데이터를 직렬화할 수 없습니다.") from exc
    if total > MAX_PALACE_BYTES:
        raise HTTPException(status_code=413, detail="저장할 데이터가 너무 큽니다.")


@app.get("/api/me")
def me(request: Request, user_id: str = Depends(require_login)) -> dict:
    """로그인 사용자 프로필(저장된 users 레코드). require_login 이 로그인 시 upsert 하므로
    여기선 읽어서 반환만 한다. Cosmos 미설정이면 헤더 클레임만으로 구성해 돌려준다."""
    stored = cosmos.get_user(user_id)
    if stored:
        return {
            "email": stored.get("email", user_id),
            "displayName": stored.get("displayName") or user_id,
            "avatarUrl": stored.get("avatarUrl") or "",
            "provider": stored.get("provider"),
        }
    prof = _principal_profile(request)
    return {
        "email": user_id,
        "displayName": prof.get("displayName") or user_id,
        "avatarUrl": "",
        "provider": None,
    }


@app.post("/api/library/save")
def library_save(payload: LibrarySaveRequest, user_id: str = Depends(require_login)) -> dict:
    if not storage.configured():
        raise HTTPException(status_code=503, detail="저장소(Blob)가 설정되지 않았습니다.")
    _reject_oversized_payload(payload.palace, payload.designs, payload.edits)
    entry = storage.save_item(
        user_id,
        payload.title,
        payload.palace,
        payload.designs,
        payload.id,
        edits=payload.edits,
    )
    if entry is None:
        raise HTTPException(status_code=503, detail="저장에 실패했습니다(저장소 오류).")
    return {"ok": True, "item": entry}


@app.get("/api/library/list")
def library_list(user_id: str = Depends(require_login)) -> dict:
    return {"items": storage.list_items(user_id)}


@app.get("/api/library/{item_id}")
def library_get(item_id: str, user_id: str = Depends(require_login)) -> dict:
    item = storage.get_item(user_id, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    return item


@app.delete("/api/library/{item_id}")
def library_delete(item_id: str, user_id: str = Depends(require_login)) -> dict:
    ok = storage.delete_item(user_id, item_id)
    return {"ok": ok}


# ── 의미부여(mnemonic): 생성 즉시 저장(번들 X, 전용 컨테이너). 죽은 /api/mnemo-save 대체. ──
class MnemonicSaveRequest(BaseModel):
    palaceId: str = Field(default="", max_length=200)
    spot: str = Field(default="", max_length=200)
    entity: str = Field(default="", max_length=200)
    markdown: str = Field(min_length=1, max_length=50_000)


@app.post("/api/mnemonic")
def mnemonic_save(
    payload: MnemonicSaveRequest, user_id: str = Depends(require_login)
) -> dict:
    """의미부여 1건 생성 즉시 저장(멱등 upsert)."""
    doc = cosmos.upsert_mnemonic(
        user_id, payload.palaceId, payload.spot, payload.entity, payload.markdown
    )
    if doc is None:
        raise HTTPException(status_code=503, detail="저장에 실패했습니다(저장소 오류).")
    return {"ok": True, "id": doc.get("id")}


@app.get("/api/mnemonic")
def mnemonic_list(
    palace: str | None = None, user_id: str = Depends(require_login)
) -> dict:
    """이 사용자(+선택 palace)의 의미부여 목록 — 방 열 때 불러와 localStorage 병합."""
    return {"items": cosmos.list_mnemonics(user_id, palace)}


@app.delete("/api/mnemonic")
def mnemonic_delete(
    palace: str = "", spot: str = "", entity: str = "", user_id: str = Depends(require_login)
) -> dict:
    return {"ok": cosmos.delete_mnemonic(user_id, palace, spot, entity)}


# 마운트된 StaticFiles 는 위 http 미들웨어를 우회한다(Starlette). HTML·JS 는 배포마다 바뀌므로
# 여기서 직접 Cache-Control:no-cache 를 붙여 브라우저가 옛 코드를 재사용하지 않게 한다(ETag로 미변경 시 304).
class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        try:
            p = path.lower()
            if p.endswith(".html") or p.endswith(".js"):
                response.headers["Cache-Control"] = "no-cache"
        except Exception:
            pass
        return response


if LEGACY_DIR.exists():
    app.mount("/legacy", NoCacheStaticFiles(directory=LEGACY_DIR, html=True), name="legacy")


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    def serve_frontend_index() -> RedirectResponse:
        # 단일 진입점 통합: 루트(/)를 랜딩(home.html: PDF 업로드 → GraphRAG → 도시 선택 → 방)으로 리다이렉트.
        #   기존 Mind Palace SPA(dist)는 보존되며 직접 경로로는 접근 가능하나, 진입은 home으로 일원화.
        return RedirectResponse("/legacy/home.html")

    _FRONTEND_DIST_RESOLVED = FRONTEND_DIST.resolve()

    @app.get("/{path:path}")
    def serve_frontend_path(path: str) -> FileResponse:
        index = FRONTEND_DIST / "index.html"
        # 경로 탐색 방어: 요청 경로가 dist 밖(../, 인코딩된 ..%2f 등)으로 벗어나면
        # 파일을 주지 않고 SPA 폴백(index.html)으로 돌린다.
        target = (FRONTEND_DIST / path).resolve()
        if target != _FRONTEND_DIST_RESOLVED and _FRONTEND_DIST_RESOLVED not in target.parents:
            return FileResponse(index)
        if target.is_file():
            return FileResponse(target)
        return FileResponse(index)
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
