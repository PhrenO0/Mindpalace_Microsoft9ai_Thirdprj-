# 사용자 DB & 내 서재 저장소

사용자 프로필과 "내 서재"(사용자가 저장한 학습 궁전)를 다루는 저장 계층 설명.

## 한눈에

- **사용자 식별/메타·서재 메타** → **Azure Cosmos DB (NoSQL)** — 작고 쿼리 대상.
- **무거운 payload**(`palace` 학습내용 + `designs` 방 구성, 최대 ~3MB JSON) → **Azure Blob** — Cosmos 문서 1건 2MB 한도를 피하려고 분리.
- 둘을 합치는 하이브리드. 미설정이면 graceful degrade(서재 API는 503), Blob만 없으면 payload를 Cosmos 문서에 인라인 폴백.

```
브라우저 ──/api/library, /api/me──▶ FastAPI(backend/app)
                                     ├─ 메타  ──▶ Cosmos DB  (mindpalace: users, library)
                                     └─ payload ─▶ Blob       (컨테이너 library)
```
(3D GLB 모델은 별개 — 브라우저가 URL로 직접 받음, 컨테이너 `models`.)

## 컨테이너 / 스키마

**`users`** (partition key `/id`) — 사용자 1명 = 문서 1건
| 필드 | 설명 |
|---|---|
| `id` | 이메일 (= 식별 키) |
| `email` | 이메일 |
| `displayName` | 표시 이름 (Entra `name` 클레임) |
| `avatarUrl` | 아바타 URL (Entra는 사진 클레임 미제공 → 보통 빈 값) |
| `provider` | `"microsoft"` |
| `oid` | Entra object id (안정 식별자, 추후 키 이전 대비 보관) |
| `createdAt` / `lastLoginAt` | 최초 생성 / 마지막 로그인 |

**`library`** (partition key `/userId`) — 저장 1건 = 문서 1건
| 필드 | 설명 |
|---|---|
| `id` | 항목 id |
| `userId` | `users.id` 와 동일 (= 파티션 키) |
| `title` | 제목 |
| `roomCount` | 방 개수(마이페이지 통계용) |
| `savedAt` / `updatedAt` | 저장/수정 시각 |
| `palaceBlobPath` / `designsBlobPath` | Blob 내 payload 경로 (`users/<id>/items/<itemId>.palace.json` 등) |
| `palace` / `designs` | *Blob 미설정 시* 인라인 폴백(작은 궁전만) |

> 마이페이지 통계(저장 수·방 수·최근 학습)는 별도 저장 없이 `library`를 쿼리해 계산.

## 코드

| 파일 | 역할 |
|---|---|
| `app/cosmos.py` | Cosmos 연결, DB/컨테이너 자동 생성, `upsert_user`/`get_user`, 서재 메타 CRUD |
| `app/storage.py` | 하이브리드 facade: 메타→Cosmos, payload→Blob(폴백 인라인) |
| `app/main.py` | 엔드포인트 + `require_login`(로그인 사용자 멱등 upsert) |

DB(`mindpalace`)와 컨테이너(`users`/`library`)는 **첫 요청 때 코드가 자동 생성**한다(수동 생성 불필요).

## 엔드포인트 (모두 `/api/` 아래)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/library/save` | 항목 저장(로그인 필요) |
| GET | `/api/library/list` | 내 항목 목록 |
| GET | `/api/library/{id}` | 항목 전체(palace 포함) |
| DELETE | `/api/library/{id}` | 항목 삭제 |
| GET | `/api/me` | 로그인 프로필 |
| GET | `/api/health` | `cosmosConfigured` / `blobStorageConfigured` 등 |

서재 API는 로그인 전용(`require_login`, Easy Auth 신원 헤더). 나머지 서비스 기능은 익명 사용 가능.

## 인증

식별 키 = **이메일**. Easy Auth principal 클레임(`preferred_username`/`emails`/`name`)에서 추출하며 Microsoft(Entra) 호환. 로그인 시 `require_login`이 `users`에 멱등 upsert.

## 환경변수

```
# Cosmos (둘 중 하나로 인증)
AZURE_COSMOS_ENDPOINT= / AZURE_COSMOS_KEY=        # 또는 AZURE_COSMOS_CONNECTION_STRING=
AZURE_COSMOS_DB_NAME=mindpalace                    # 기본 mindpalace
AZURE_COSMOS_MAX_RU=1000                           # 프로비저닝 오토스케일 상한
# AZURE_COSMOS_SERVERLESS=true                     # 서버리스 계정일 때만

# Blob
AZURE_APP_STORAGE_CONNECTION_STRING=              # 서재 payload용(앱과 같은 리전 권장). 없으면 아래로 폴백
AZURE_STORAGE_CONNECTION_STRING=                  # GLB(models)용
LIBRARY_BLOB_CONTAINER=library                    # 기본 library (자동 생성)
```

미설정 시: Cosmos 없으면 서재 API 503, Blob 없으면 payload 인라인 저장. 자세한 운영/배포 절차는 루트 `.env.example` 참고.
