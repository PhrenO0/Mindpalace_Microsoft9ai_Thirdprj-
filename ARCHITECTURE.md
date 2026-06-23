# 기억의 궁전 — 전체 아키텍처 총정리 (3D 공간 마커 시스템)

> **이 문서 하나로 시스템 전체를 이해한다.** 임의의 3D 방(GLB)이나 실제 방 사진을 입력받아 → 가구를 인식하고 → 3D 좌표를 부여하고 → 걷는 동선 순서로 번호를 매겨 → 학습 개념을 공간에 배치하는(장소법, method of loci) 파이프라인의 모든 기술을 모았다.
>
> 모든 주장은 실제 동작 코드(`frontend/public/legacy/memory-walk.html`, `personal-room-scanner-3d.html`, `backend/app/main.py`)에 근거하며, 멀티 에이전트 소스 대조 검증을 거쳤다. 전문 용어는 처음 등장 시 풀어 쓰고 끝에 용어집(§12)을 둔다.
>
> 더 자세한 단일 주제 문서: 친근한 설명 `legacy/how-markers-work.html` · 파이프라인 상세 `3D-PIPELINE-TECHNICAL-SHARE.md` · 인식 딥다이브 `3D-RECOGNITION-DEEPDIVE.md` · 핫스팟 `HOTSPOT-3D-PIPELINE.md`.

---

## 0. 큰 그림 — 두 입력 경로, 하나의 좌표계, 3계층 우선순위

```
 3D 모델(GLB) ─▶ [경로 A] 메쉬 정점 → AABB 중심 (좌표를 '읽음', 무오차) ─┐
                                                                          ├─ 같은 정규화 좌표계
 실제 방 사진 ─▶ [경로 B] Azure Vision → 레이캐스트+삼각측량 (좌표 '복원') ─┘   (가로 7.2 · 바닥 y=0)
                                                                          │
        위치 우선순위(3계층):  ① 사용자 편집  >  ② 스캐너 hotspots JSON  >  ③ GLB 기하
                                                                          ▼
   객체 인식·이름(AI) · 겹침 정리 · 동선(최근접) · 표면 부착(snapY) · 카메라 연속성
                                                                          ▼
                          번호가 매겨진 3D 학습 마커 + 1인칭 워크스루
```

**핵심 원칙:** *위치(좌표)는 가능하면 측정하지 않고 읽거나(A) 복원(B)하고, 이름(무엇인가)만 AI로 판정한다.* 좌표와 이름은 분리된 문제다.

**★ 프리셋(데모) 방의 실제 활성 소스 = ②계층(스캐너 JSON).** `memory-walk.html`의 `LANDMARK_ROOMS`(10개 방)와 `compose.html`이 전부 `<room>-hotspots.json`을 넘겨 런타임이 ②계층으로 로드하고 ③(GLB 기하)을 **덮어쓴다.** 따라서 사용자가 데모에서 보는 마커는 **스캐너 산출물**이며, ③ GLB 기하(§2·§3)는 *hotspots JSON이 없는 GLB*(기본 `3dfront-livingroom.glb`, 새로 업로드한 임의 GLB, 미스캔 방)에서만 활성화되는 **폴백**이다.

---

## 1. GLB 처리 — 라벨 있는 것 vs 없는 것

GLB(3D 모델 파일)는 GLTFLoader + DRACOLoader로 로드한다(`memory-walk.html` 로더 설정 ~L629, DRACO 디코더는 CDN jsdelivr `three@0.160.0`). 네트워크 정지 대비 45초 워치독이 있다. 로드 후 가구를 찾는 방식이 **라벨 유무에 따라 두 패스**로 갈린다.

### 1.1 라벨(이름표) 있는 GLB — 이름 패스
메쉬/노드 이름이 가구 단어이면 신뢰한다. 3D-FRONT·DiffuScene·Sketchfab GLB는 보통 부모 노드/그룹명에 `Sofa_01`, `DiningSet > chair_03` 같은 종류 단서가 들어 있다.

```js
const FURN_RE = /Factory|Sofa|Couch|Cabinet|Table|Desk|Chair|Seat|Bed|Lighting|Lamp|Shelf|Stand|
  Bookcase|Wardrobe|Stool|Plant|Dresser|Bench|Nightstand|Vase|Jar|Bowl|Candle|window|sink|carpet|painting/i;
if (FURN_RE.test(c.name) && !/^None/i.test(c.name)) {            // 이름이 가구 단어 → 신뢰 앵커
  anchors.push({ pos: bboxCenter, label: matchedWord, ko: furnKO(...), named: true });
}
```
- 이름이 확실하면 `named: true` → 뒤(§3.3)의 AI 비전 교정에서 **제외**(정확도 보존 + LLM 호출 절약).
- 한국어 이름은 `inferFurnLabel`이 **메쉬 + 조상 4단계 이름**을 이어 붙여 가구 사전(`FURN_KO`)에 매칭한다.

### 1.2 라벨 없는/명명규칙 다른 GLB — 기하 패스
이름이 없거나(`Object_12` 같은) 다른 규칙이어도 **형태(크기·모양)** 로 가구를 인식한다. 구조물(벽·바닥·천장)은 모양으로 배제한다. 정규화된 방(가로 7.2 단위) 기준 게이트:

```js
const roomMax = 7.2, roomH = size.y * scale;
if (maxd < roomMax*0.03 || maxd > roomMax*0.92) return;                              // 소품(너무 작음)·구조물(너무 큼) 제외
if (thin < roomMax*0.028 && (s.y > roomH*0.45 || wide > roomMax*0.30)) return;        // 얇고 큰 면 = 벽·칸막이
if (s.y < roomMax*0.012 && wide > roomMax*0.45) return;                               // 아주 납작·거대 = 바닥/천장 슬래브
if (s.y > roomH*0.82 && wide > roomMax*0.12) return;                                  // 바닥~천장 전 높이 = 기둥/벽
if (ctr.y > roomH*0.72) return;                                                       // 천장 부착물(조명) 제외
```
- 후보를 **부피 내림차순** 정렬 → `MINSEP ≈ 0.5 m`(=`roomMax*0.07`) 공간 디클러스터링으로 채택, 실제 메쉬 기반 인식 상한 ~22개.
- 이름도 전혀 없으면 `geomGuess`가 **정규화 크기 비율**로 종류 추정(러그/침대/소파/수납장/책장/스탠드/테이블/의자/소품). 한계가 있어 §3.3 비전이 덮어쓴다.

> **요약:** 라벨 있으면 "이름을 믿고", 없으면 "모양으로 거른다." 어떤 GLB든(이름표 유무·명명규칙 무관) 동작하도록 설계됐고, AI 개입 없이 클라이언트에서 인식한다.

---

## 2. 정확한 위치·좌표를 잡는 법

### 2.1 정규화 — 모든 방을 같은 자로
GLB마다 제작 단위(cm·inch·임의 스케일)가 달라서, 거리 임계값(0.42 m·0.5 m·7% 등)을 공유하려면 한 번 정규화한다. 배경 메쉬(스카이박스·압도적으로 큰 평면)는 `findBackdrops`로 제외해 척도 오염을 막는다.

```js
const rbox = new THREE.Box3(); all.forEach(m => { if (!backs.has(m)) rbox.expandByObject(m); }); // 배경 제외 '실제 방'
const size = rbox.getSize(v3()), center = rbox.getCenter(v3());
const scale = 7.2 / Math.max(size.x, size.z, 0.001);                  // 가로 긴 변 = 7.2 단위
model.scale.setScalar(scale);                                         // 균일 스케일(가구 비율 유지)
model.position.set(-center.x*scale, -rbox.min.y*scale, -center.z*scale); // 바닥→y0, 수평 중심→원점
```
- **x, z** = 바닥 평면, 가로 긴 변 7.2 단위, 수평 중심 = 원점. **y** = 높이, 바닥 0, 천장 `roomH`.
- **7.2는 물리 상수가 아니라 공통 자(척도).** 스캐너(경로 B)도 같은 값을 써서 두 경로 좌표가 호환된다.

### 2.2 경로 A — GLB 기하: AABB 중심 (무오차)
각 가구 위치 = **축 정렬 경계 상자(AABB)의 중심**. AI도 렌더링도 없는 순수 기하 연산.
```js
const b = new THREE.Box3().setFromObject(mesh);  // 정점을 월드 변환 후 축별 min/max
const pos = b.getCenter(new THREE.Vector3());     // 상자 중심 = 좌표(렌더링 없이 정점만 읽음 → 오차 0)
```

### 2.3 경로 B — 스캐너: 사진 → 삼각측량 (좌표 복원)
사진은 2D라 깊이가 없으므로 좌표를 **복원**한다(`personal-room-scanner-3d.html`).
1. **검출:** Azure AI Vision(`/api/detect` 프록시, 주력) / 브라우저 OWL-ViT(폴백). 라벨 표기 차이(couch↔sofa)는 공통 단어로 정규화.
2. **다시점 광선 클러스터링:** 각 사진의 검출에서 카메라→검출중심 광선을 만들고, 여러 샷의 같은 사물 광선을 **0.85 m 근접도**로 군집.
3. **위치 확정(`finalizeCluster`):** best-shot 레이캐스트(표면 적중점)가 주력. **삼각측량은 가림(occlusion) 의심일 때만 보정** — 적중점이 다시점 수렴점과 0.6 m 이상 어긋나고 수렴 RMS<0.35 m면 수렴점 채택. RMS<0.5 m만 신뢰. 신뢰도 배지 `삼각측량 ±{RMS×100}cm`.
4. **산출물:** `public/data/<room>-hotspots.json`(`markerPosition` = 같은 7.2 정규화 좌표).

> **★ GLB엔 삼각측량이 거의 안 쓰인다 (소스 검증).** GLB는 정점(좌표)을 이미 가져 위치는 메쉬에서 바로 나온다 — 런타임은 AABB 중심(§2.2), 스캐너는 box-center 레이캐스트(메쉬 표면 적중). **삼각측량은 본래 '좌표 없는 실제 사진'을 위한 기법**이고, GLB에선 '가림 의심'(적중점이 다시점 수렴점과 0.6 m↑ 어긋남) 보정 예외에서만 끼어든다. 실제 구워진 프리셋 hotspots JSON의 `generatedBy`는 전부 `GLB node names` / `box-center raycast` / `Azure AI Vision`이며 **`triangulation` 0건**(per-hotspot `posMethod`도 미기록). → 가구별로 깔끔히 분리된 GLB라면 스캐너 없이 런타임 AABB(§2.2)로 충분하고, 스캐너는 **통짜로 융합된 메쉬·오라벨 GLB에서 Azure Vision으로 가구를 찾아낼 때** 가치가 있다.

### 2.4 세그멘테이션 — 부정확이 생기는 진짜 지점
좌표 자체는 정확하다. 오류는 "어떤 정점들이 한 사물인가"의 그룹핑(세그멘테이션)에서 생긴다.
- **과분할**(한 가구가 여러 메쉬) → 마커 중복 → `MINSEP` 0.5 m 스킵 + `mergeAnchors`(같은 라벨 1.0 m 병합) + XZ 평면 0.42 m 겹침 제거(높이 다른 러그+그림처럼 위에서 겹치는 중복).
- **과병합**(여러 가구가 한 메쉬) → 좌표 뭉침 → 크기 게이트로 통짜 메쉬 배제 후 ②·① 계층으로 폴백(기하학으론 못 쪼갬).

---

## 3. 객체 인식 (최신 업데이트 반영)

좌표는 정확해도 **이름**(메쉬 라벨·기하 추정)은 틀릴 수 있다(라벨 `umbrella`인데 실제 화분). 그래서 **실제 렌더 픽셀을 스크린샷으로 찍어 멀티모달 LLM(GPT-4.1 비전)에 질의**한다. 검출은 클라우드(Azure), 좌표 계산(레이캐스트)은 클라이언트로 분리한다.

### 3.1 이름 신뢰 하이브리드 — 어디에 비전을 쓸지
```js
var AMBIG_NAME_RE = /umbrella|parasol|kite|globe|\btoy\b|object|mesh|none|untitled|default/i;
function isNamedMarker(h){
  if (/^obj\d+$/.test(h.label) || h.label === "spot") return false; // 기하추정·합성지점 → 비전
  if (AMBIG_NAME_RE.test(h.label)) return false;                    // 모호·오명명 → 비전이 판단
  return true;                                                      // 진짜 가구 이름 = 신뢰, 비전 제외
}
```
신뢰되는 이름(식탁·소파)은 비전이 덮지 않고, 비전은 `obj숫자`·`spot`·모호한 이름에만 작동 → 정확도 보존 + 호출 절약.

### 3.2 배치 명명 — 4각도 (`POST /api/label-room`)
번호 마커가 박힌 방을 네 모서리 각도(yaw = ±π/4, ±3π/4)로 렌더 → JPEG → `/api/label-room`(GPT-4.1 비전)이 `{번호: 한글명}` 반환. 캐시 `mp_vision_labels:{glb}`.

### 3.3 사물별 정밀 — 오프스크린 클로즈업 (`POST /api/vision-label`)
가장 정확한 단계. 보이는 카메라를 건드리지 않고 각 마커를 정면 클로즈업으로 **오프스크린(메모리 텍스처)** 에 별도 렌더:
```js
const _offRT = new THREE.WebGLRenderTarget(512, 512);
_offCam.position.copy(clearViewPos(h.eye)); _offCam.lookAt(h.pos);
renderer.setRenderTarget(_offRT); renderer.render(scene, _offCam);  // 화면 아닌 텍스처에 렌더
renderer.readRenderTargetPixels(_offRT, 0,0,512,512, buf);          // GPU→CPU 픽셀 리드백(+상하 반전)
const v = h.pos.clone().project(_offCam);                            // 3D 마커 → NDC(-1..+1)
const sx=(v.x+1)/2, sy=(1-v.y)/2;                                    // NDC → 화면 비율(0..1)
// (sx,sy) 둘레 크롭 + 빨간 십자선 → '바로 이 점'만 보게 → /api/vision-label
```
**투영(projection)** 이 3D 좌표와 2D 크롭을 잇는 다리. 십자선은 얇은 사물 뒤 큰 배경(커튼)으로 시선이 새는 것을 막는다. 캐시 `mp_vision_precise:{glb}`. 중앙이 바닥/벽/빈 공간이면 "없음" → 빈 자리 처리. 백엔드 폴백 = Azure Computer Vision(`/api/detect`).

---

## 4. 핫스팟 번호 매기기 — 검출 순서가 아니라 동선 순서

마커 번호는 **검출된 순서가 아니라, 사람이 실제로 한 바퀴 걷는 경로 순서**로 매긴다. (걷는 순서 = 학습 서사 순서.) 학습 항목이 가구보다 많으면 빈 바닥 격자가 아니라 검출된 가구 곁(중심쪽 0.6~0.9 m)에 합성 '기억 지점'(`label:"spot"`)을 둔다(허공 마커 방지). 가구가 0개일 때만 격자 폴백.

---

## 5. 동선 설계 — 최근접 이웃 + 진행방향 유지

`designRoute`가 매 단계 최고점 후보를 골라 한 바퀴를 만든다.
```js
const turn  = (Δx/dist)*dirX + (Δz/dist)*dirZ;   // +1=직진, -1=뒤로(큰 회전)
const score = -dist + turn*0.7;                   // 가까움 우선 + 방향 유지(지그재그 억제)
```
- **가까움**(미방문 최근접)으로 동선을 짧게, **방향 유지**(가던 방향과 유사하면 가산, 뒤로 꺾이면 감점)로 지그재그·횡단을 억제 → 되돌아가지 않는 자연스러운 한붓 동선.

---

## 6. 핫스팟을 눌렀을 때 — 카메라가 화면을 잡는 기준

핫스팟(마커 또는 목록 항목)을 누르면 `goTo(i)`가 실행된다.
```js
function goTo(i, instant){
  activeIdx = i; const h = route[i];
  const camPos = clearViewPos(h.eye);                 // 마커를 '잘 보는' 카메라 위치 계산
  flyTo(camPos, h.eye.clone(), instant ? 0 : 900);    // 그 위치로 부드럽게, 마커를 바라보며
}
```

### 6.1 카메라 위치 선정 — `clearViewPos` (어떤 기준으로 화면을 잡나)
마커 주변 **28방향**을 레이캐스트로 평가해 점수가 가장 높은 자리를 카메라 위치로 고른다:
```js
const cont  = -(dir · curFwd);                                  // 직전 시선과 정렬될수록 +
const score = open*1.0 + facing*1.1 + dist*0.4 + cont*1.25;     // 연속성 가중 1.25 → 180° 휙 회전 억제
```
- **open(트인 정도)** — 그 방향에서 마커가 다른 가구에 가리지 않고 잘 보이는가.
- **facing(방 중심 지향)** — 벽을 등지고 방 안쪽을 바라보는 구도인가.
- **dist(거리)** — 너무 붙지도 멀지도 않은 적정 거리.
- **cont(연속성, 가중치 최대 1.25)** — 직전에 보던 시선 방향과 비슷한가. 이 가중이 커서 **장면이 180° 홱 돌지 않고** 이어진다(멀미 방지).

### 6.2 카메라 이동 — `flyTo`
선정한 위치로 **`flyTo(easeInOutCubic, 900 ms)`** 트윈 이동, 마커(`h.eye`)를 바라본다. 트윈 중에는 `walk()`·`clampInsideRoom()`을 생략해 흔들림을 없앤다. 활성 마커는 커지고(스케일 0.44 vs 0.34) 설명 카드가 뜬다. `다음`/`이전`/`투어` 버튼도 모두 `goTo`를 호출한다.

---

## 7. 위치 관리·영속화 — 3계층 + 내 서재(서버 저장)

각 사물 = **앵커 레코드** `{ pos, label, ko, named, entityId, conf }`. 위치는 단일 소스가 아니라 폴백 체인으로 관리한다.

| 계층 | 소스 | 키 / 성격 |
|---|---|---|
| **① 사용자 편집**(최우선) | 마커 드래그·삭제·순서변경 | `localStorage["mw_edit:"+glb]`, `posMethod:"manual-edit"` |
| **② 스캐너 hotspots** | 사진 + Azure Vision + 삼각측량(§2.3) | `<glb>-hotspots.json` (프리셋 활성 소스) |
| **③ GLB 기하**(폴백) | AABB 중심(§2.2) | 기본값. ①②가 없을 때만 |

- **공유 좌표계:** 세 소스 전부 7.2·바닥 0 → 갈아끼움 가능.
- **정체성:** 앵커는 `entityId`로 학습 개념에 바인딩 → 순서변경·이동·리로드에도 "이 사물 = 이 개념" 유지.
- **순서 저장:** 학습 항목 순서는 `mw_itemorder:{city}:{room}` 캐시 키.
- **★ 최신: 내 서재 서버 저장** — 현재 세션 스냅샷(궁전 + designs + 의미부여 + 노드편집)을 `POST /api/library/save`(credentials 포함)로 우리 DB(**Cosmos + Blob**)에 영속화. 로그인 사용자별로 격리되어, 재방문 시 편집·궁전이 복원된다. (편집은 스캐너 JSON과 동일 형식 `editJSON`으로도 내보내 ②계층에 영구 반영 가능.)

---

## 8. 백엔드 API & LLM 구성 (`backend/app/main.py`)

| 경로 | 역할 | 엔진/파라미터 |
|---|---|---|
| `GET /api/vision-config` | Azure Vision 구성 여부 | `{azure: bool}` |
| `POST /api/detect` | 단일 이미지 객체 검출 | Azure Computer Vision(objects + dense captions) |
| `POST /api/vision-label` | 크롭 1장 → 한국어 사물명 | GPT-4.1 비전, 중앙 조준, `max_tokens 60`, `temp 0`, `json_object` |
| `POST /api/label-room` | 4각도(≤6장)+번호 → `{번호:명}` | GPT-4.1 비전, `max_tokens 700` |
| `POST /api/library/save` 등 | 내 서재(궁전·편집) 저장/조회 | Cosmos + Blob (사용자별 격리) |

- LLM 구성(`llm_chat_config`): 모델은 코드에 하드코딩이 아니라 **`AZURE_OPENAI_DEPLOYMENT` 환경변수의 배포**로 결정(이 서비스는 GPT-4.1 배포 사용). 기본 API 버전 `2025-01-01-preview`(gpt-4.1 지원). Azure 미설정 시 OpenAI 폴백 기본 모델 `gpt-4o-mini`. 모든 비전 호출은 `temperature 0` + `json_object`로 결정적·파싱 안전.
- ⚠️ 운영 함정: 스냅샷/var를 `/home`(Azure Files/SMB)에 두면 lancedb가 0바이트로 깨진다 → 기본 `REPO/var`, 재시작 생존은 Blob 영속. `AZURE_OPENAI_API_VERSION`을 옛 값으로 덮으면 `gpt-4.1-mini` 404(삭제 또는 `2025-01-01-preview`).

---

## 9. 데이터 계약 (스키마)

**hotspots JSON** (스캐너 산출 / 편집 저장 공통)
```jsonc
{ "hotspots": [{
    "slot": 1, "object": "chair", "detectedClass": "chair", "confidence": 0.82,
    "markerPosition": [x, y, z],                        // 정규화 좌표(가로 7.2·바닥 0)
    "posMethod": "raycast" | "triangulation" | "manual-edit",
    "entityId": "<학습개념 바인딩, nullable>"
}]}
```
**캐시 키:** `mp_vision_labels:{glb}` · `mp_vision_precise:{glb}` · `mw_edit:{glb}` · `mw_itemorder:{city}:{room}`.
**palace.json**(GraphRAG 산출, 학습 개념 측): 방(rooms)·개념(kept)·관계(relationships). 프론트는 `entities[].title` ↔ `rooms[*].kept[*].title`로 "관련 방"을 매칭한다(상세 `graphrag` 레포 `docs/palace_schema_contract.md`).

---

## 10. 정확도·한계·QA

- **좌표:** 경로 A 무오차(읽기), 경로 B는 RMS로 정량화(잘 수렴 시 ±수 cm).
- **세그멘테이션:** 과분할은 병합으로, 과병합(통짜 메쉬)은 기하학으론 불가 → 스캐너·손편집 계층으로.
- **AABB 중심 ≠ 표면 중심:** `snapY`(하향 레이캐스트)로 y만 표면에 다시 얹는다. ㄱ자·불규칙 사물은 손편집 여지.
- **비전:** 얇은 사물 뒤 큰 배경에 약함 → 십자선 + '정밀' 버튼.
- **QA 절차(정확한 변수명):** `memory-walk.html?glb=<URL>&palace=<json>` 로드 → 콘솔에서 **`window.__mw.route`**(= `window.__mw` 는 `{route, anchors, ordered}`)로 번호·ko·pos 확인, **`window.__mpDetectReport`**(count·byType·warn: sparse/skewed) 점검. **합격선:** XZ 0.42 m 겹침 0 · 한 종류 과다 없음 · 동선 큰 점프(>3 m) 최소 · 천장/허공 마커 없음.

---

## 11. 처리 흐름 한눈에 (새 GLB가 들어왔을 때)

1. **로드** — GLTFLoader+DRACO로 GLB 디코드(45초 워치독).
2. **정규화** — 배경 제외 → 가로 7.2·바닥 0으로 균일 스케일.
3. **가구 검출** — 라벨 있으면 이름 패스(`FURN_RE`), 없으면 기하 패스(크기·형태 게이트), 디클러스터링(MINSEP 0.5 m), 최대 ~22개.
4. **위치** — ② hotspots JSON 있으면 그걸 활성(프리셋), 없으면 ③ AABB 중심.
5. **이름** — `inferFurnLabel`→`geomGuess`→(모호·합성만) GPT-4.1 비전(4각도 + 오프스크린 클로즈업).
6. **정리** — `mergeAnchors`·XZ 0.42 m 겹침 제거·`snapY` 표면 부착.
7. **동선·번호** — `designRoute`(최근접+방향) → 한붓 순서로 번호.
8. **개념 바인딩** — `entityId`로 palace.json 학습 개념 연결.
9. **워크스루** — 핫스팟 클릭 → `goTo` → `clearViewPos`(28방향 트인정도+방중심+연속성) → `flyTo`(900 ms).
10. **영속화** — `mw_edit`/`mw_itemorder` 로컬 + 내 서재 `/api/library/save`(Cosmos+Blob).

---

## 12. 용어집

| 용어 | 쉬운 뜻 |
|---|---|
| GLB | 3D 방 모델 파일. 좌표가 이미 들어 있음. |
| 정규화(normalization) | 방마다 다른 크기를 같은 척도(가로 7.2)로 맞추기. 거리 기준 공유용. |
| AABB(축 정렬 경계 상자) | 사물을 감싸는 가장 작은 직육면체. 중심 = 사물 위치. |
| 레이캐스팅 | 한 점에서 광선을 쏴 처음 맞는 표면 찾기. |
| 삼각측량 | 여러 시점 광선이 만나는 점으로 3D 위치 복원. 좌표 없는 사진에 사용. |
| RMS(평균제곱근 오차) | 광선들이 한 점에 얼마나 잘 모였는지의 오차. 작을수록 정확. |
| occlusion(가림) | 앞 물체가 뒤를 가려 광선이 엉뚱한 표면을 맞는 상황. 삼각측량 보정 트리거. |
| 세그멘테이션 | "어떤 부분이 한 사물인가"를 가르기. 좌표가 아니라 그룹핑의 문제. |
| NDC(정규화 장치 좌표) | 3D 점을 카메라로 투영한 -1~+1 화면 좌표. 크롭·십자선 계산에 사용. |
| 투영(projection) | 3D 점을 2D 화면 좌표로 변환. 좌표↔스크린샷을 잇는 다리. |
| 오프스크린 렌더 | 화면이 아니라 메모리 텍스처에 그리기. 사용자 화면 안 건드리고 클로즈업 캡처. |
| OWL-ViT | 임의 라벨 이미지 검출 모델. Azure 미설정 시 브라우저 폴백. |
| 멀티모달 LLM | 텍스트+이미지를 함께 이해하는 모델(여기선 GPT-4.1 비전). |
| method of loci(장소법) | 익숙한 공간 자리에 정보를 배치해 외우는 고전 기억술. 이 시스템의 학습 원리. |

---

*근거: `frontend/public/legacy/memory-walk.html`, `personal-room-scanner-3d.html`, `backend/app/main.py` (실제 소스) + 멀티 에이전트 소스 대조 검증(라인번호·전역변수명 정정 반영) + 라이브 엔드포인트 점검. 작성 2026-06-23.*
