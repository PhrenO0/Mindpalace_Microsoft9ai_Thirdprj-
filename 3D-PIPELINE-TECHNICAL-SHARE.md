# 기억의 궁전 — 3D 공간 마커 파이프라인 기술 문서 (공유용)

> **무엇을 하는 시스템인가** — 임의의 3D 방(GLB) 또는 실제 방 사진을 입력받아, **가구·사물을 인식하고 3D 좌표를 부여하고 걷는 동선 순서로 번호를 매겨**, 학습 개념을 공간에 배치(method of loci, 장소법)하는 파이프라인.
>
> 이 문서는 **실제 동작하는 코드**(`memory-walk.html`, `personal-room-scanner-3d.html`, `backend/app/main.py`)에 근거한다. 전문 용어를 사용하되, 처음 등장할 때 풀어 쓰고 끝에 **용어집(§11)**을 둔다. 라인 참조는 실제 소스 기준.

---

## 0. 한눈에 — 두 입력 경로, 하나의 좌표계

마커의 3D 좌표를 얻는 길은 두 가지이고, **둘 다 같은 정규화 좌표계**(가로 7.2 · 바닥 y=0)로 수렴한다.

```
                         ┌──────────────────────────────────────────────┐
  3D 모델(GLB)  ────────▶│  경로 A · 지오메트리   메쉬 정점 → AABB 중심   │
  (좌표가 이미 있음)      │   (삼각측량 불필요, 무오차)                    │──┐
                         └──────────────────────────────────────────────┘  │
                                                                            │  같은
                         ┌──────────────────────────────────────────────┐  │  정규화
  실제 방 사진   ────────▶│  경로 B · 스캐너   Azure Vision 검출 →         │  │  좌표계
  (좌표 없음 = 2D)        │   레이캐스트 + 삼각측량 → hotspots JSON        │──┤  (7.2 / 바닥 0)
                         └──────────────────────────────────────────────┘  │
                                                                            ▼
   위치 관리(3계층): ① 사용자 편집 > ② 스캐너 hotspots > ③ GLB 기하 ──▶ 앵커 배열
                                                                            │
   비전 정밀 명명(공통) · 겹침 정리 · 동선(최근접) · 표면 부착(snapY) · 카메라 연속성
                                                                            ▼
                                              번호가 매겨진 3D 학습 마커 + 1인칭 동선
```

**핵심 원칙**: *위치(좌표)는 가능하면 측정하지 않고 읽거나(경로 A) 복원한다(경로 B). 이름(무엇인가)만 AI로 판정한다.* 좌표와 이름은 분리된 문제다.

---

## 1. 좌표계 — 정규화(normalization)

모든 GLB는 제작 단위(cm·inch·임의 스케일)가 제각각이라, 거리 임계값을 공유하려면 **한 번 정규화**해 공통 좌표계로 옮긴다. [`memory-walk.html` L703–717, `roomH`는 가구 인식 블록의 L738]

```js
const rbox = new THREE.Box3();
all.forEach(m => { if (!backs.has(m)) rbox.expandByObject(m); });   // 배경(backdrop) 제외한 '실제 방'
const size = rbox.getSize(v3()), center = rbox.getCenter(v3());
const scale = 7.2 / Math.max(size.x, size.z, 0.001);                // 가로 긴 쪽 = 7.2
model.scale.setScalar(scale);                                      // 균일 스케일(가구 비율 유지)
model.position.set(-center.x*scale, -rbox.min.y*scale, -center.z*scale);  // 바닥→y0, 중심→원점
const roomH = size.y * scale;                                      // 정규화된 방 높이
```

| 축 | 의미 | 정규화 후 |
|----|------|-----------|
| x, z | 바닥 평면 | 가로 긴 변 = **7.2 단위**, 수평 중심 = 원점 |
| y | 높이 | 바닥 = **0**, 천장 = `roomH` |

**7.2의 의미**: 물리 상수가 아니라 **공통 자(척도)**. 방 스캐너(경로 B)도 같은 값을 써서 두 경로 좌표가 호환된다. 정규화 후엔 모든 임계값(0.42 m, 0.5 m, 7% 등)이 **모든 방에서 같은 물리적 의미**를 갖는다. 배경 메쉬(skybox·거대 평면)는 `findBackdrops`로 제외해 척도 오염을 막는다.

---

## 2. 경로 A — GLB 지오메트리 파이프라인

### 2.1 위치 추출: 메쉬 → AABB → 중심

각 사물(메쉬)의 위치는 **축 정렬 경계 상자(AABB, Axis-Aligned Bounding Box)의 중심**이다. AI도 렌더링도 필요 없는 순수 기하 연산.

```js
const b = new THREE.Box3().setFromObject(mesh);   // 모든 정점을 월드 변환 후 축별 min/max
const pos = b.getCenter(new THREE.Vector3());       // 상자 중심 = 사물 좌표(anchor.pos)
```

`Box3.setFromObject`는 메쉬(+자식)의 정점 또는 `geometry.boundingBox`를 월드 행렬(정규화 포함)로 변환해 각 축의 최소·최대를 잡는다. **렌더링 없이 정점 좌표만 읽으므로 위치 오차 0.**

### 2.2 검출: 이름 패스 + 기하 패스

**(a) 이름 패스** — 메쉬 이름이 가구 단어이면 신뢰. [L726–729]

```js
const FURN_RE = /Factory|Sofa|Couch|Cabinet|Table|Desk|Chair|Seat|Bed|Lighting|Lamp|Shelf|Stand|
                 Bookcase|Wardrobe|Stool|Plant|Dresser|Bench|Nightstand|Vase|Jar|Bowl|Candle|window|sink|carpet|painting/i;
if (FURN_RE.test(c.name) && !/^None/i.test(c.name)) {
  anchors.push({ pos: bboxCenter, label: matchedWord, ko: furnKO(...), named: true });
}
```

**(b) 기하 패스** — 이름 없는/명명규칙 다른 GLB도 **형태로** 인식. 구조물(벽·바닥·천장)을 모양으로 배제. [L734–768]

```js
const roomMax = 7.2;
// 크기 게이트: 소품(<3%)·구조물(>92%) 제외
if (maxd < roomMax*0.03 || maxd > roomMax*0.92) return;
// 형태 게이트(이름 없어도 구조물 배제)
if (thin < roomMax*0.028 && (s.y > roomH*0.45 || wide > roomMax*0.30)) return;  // 얇고 큰 면 = 벽
if (s.y < roomMax*0.012 && wide > roomMax*0.45) return;                          // 납작·거대 = 바닥/천장
if (s.y > roomH*0.82  && wide > roomMax*0.12) return;                            // 전체 높이 = 기둥/벽
if (ctr.y > roomH*0.72) return;                                                  // 천장 부착물(조명) 제외
```

각 후보는 부피 내림차순 정렬 후 `MINSEP ≈ 0.5 m`(=`roomMax*0.07`) 공간 디클러스터링으로 채택. `named` 플래그는 계층 이름 추론 성공 여부(`!!c.ko`).

### 2.3 명명: 이름 추론 + 기하 추정

- **`inferFurnLabel`** [L1549] — 메쉬 + 조상 4단계 이름을 이어 붙여 가구 사전(`FURN_KO`) 매칭. (GLB 계층 `Room > DiningSet > chair_03`의 단서 활용)
- **`geomGuess`** [L1561] — 이름이 전혀 없을 때, **정규화 크기 비율**로 추정(러그/침대/소파/수납장/책장/스탠드/테이블/의자/소품). 본질적 한계가 있어 §4의 비전이 덮어쓴다.

### 2.4 세그멘테이션(instance segmentation) 처리

> **세그멘테이션** = "어떤 정점들이 한 사물인가"의 그룹핑 문제. 부정확은 좌표가 아니라 **여기서** 생긴다.

| 실패 방향 | 증상 | 대응 |
|-----------|------|------|
| **과분할**(over-segmentation) — 한 가구가 여러 메쉬 | 마커 중복 | `MINSEP` 0.5 m 스킵, `mergeAnchors`(같은 label 1.0 m 병합 — 함수 L797 · 호출 L777), XZ 평면 0.42 m 겹침 제거 [L1063] |
| **과병합/미분할**(under-segmentation) — 여러 가구가 한 메쉬 | 좌표가 뭉침 | 크기 게이트로 통짜 메쉬 배제 → §5 ②·① 계층으로 폴백 (기하학으론 **쪼갤 수 없음**: 정점이 한 덩어리) |

XZ(바닥 평면) 겹침 제거는 **높이가 다른 두 사물**(바닥 러그 + 벽 그림)이 위에서 보면 겹치는 중복을 잡는다 — 3D 거리만 보면 높이차로 안 걸러지기 때문.

---

## 3. 경로 B — 스캐너: 사진 → 삼각측량 (`personal-room-scanner-3d.html`)

3D 모델에 이름표가 없거나 **실제 방 사진**만 있을 때. 사진은 2D라 깊이가 없으므로, 좌표를 **읽는** 게 아니라 **복원**한다.

### 3.1 검출: Azure AI Vision (주력) / OWL-ViT (폴백)

```js
fetch("/api/vision-config").then(r=>r.json()).then(c=>{ USE_AZURE = !!c.azure; });  // [L263]
// detectObjects(L509–534): Azure 분기(/api/detect, L510–528) 우선, 없으면 브라우저 OWL-ViT 폴백(L529–533)
```

- **Azure AI Vision** — 서버 키 있으면 `/api/detect` 프록시로 호출. 다단어 라벨("dining table", "office chair")도 반환.
- **OWL-ViT** — 오픈 보캐뷸러리(open-vocabulary) 브라우저 검출 모델, 폴백.
- 검출기마다 라벨 표기가 달라(Azure "couch" / OWL "sofa") **공통 단어로 정규화**.

### 3.2 다시점 광선 클러스터링(multi-view ray clustering)

각 사진의 각 검출에서 카메라 원점을 지나 검출 중심을 향하는 **광선(ray)**을 만든다. 여러 샷의 같은 사물 광선을 **근접도로 군집**. [L540–563]

```js
const { dist, sa, tb } = raysClosest(c.ray, m.ray);   // 두 광선의 최단접근 거리
if (sa>0 && tb>0 && dist < 0.85) → 같은 클러스터;       // 0.85 m 안에서 만나면 동일 사물
// 같은 라벨이 1 m 내면 통합(분리 검출된 한 사물)
```

### 3.3 위치 확정: best-shot 레이캐스트 + 삼각측량 보정 [`finalizeCluster` L571–597]

```js
k.rays = members.map(m => ({ o, d, w: clamp(m.score, .1, 1) }));   // 검출 점수를 가중치로
const triRes = k.rays.length >= 2 ? triangulateRays(k.rays) : null;
const tri = (triRes && inBounds && triRes.rms < 0.5) ? triRes.point : null;   // RMS<0.5 m만 신뢰
if (withHit.length) {
  const bestHit = highestScoreShot.hit;                 // GLB 표면에 쏜 적중점
  if (tri && triRes.rms < 0.35 && bestHit.distanceTo(tri) > 0.6)
       { k.point = tri; k.posMethod = "triangulation"; } // 가림 의심 → 삼각측량 보정
  else { k.point = bestHit; k.posMethod = "raycast"; }   // 정상 → 표면 적중(주력)
} else if (tri) { k.point = tri; k.posMethod = "triangulation"; }  // 적중 없으면 삼각측량
else            { k.point = rayPoint(k.rays[0]); k.posMethod = "guess"; }  // 불확실
```

**설계 의도** — GLB라는 3D 형상을 이미 가졌으므로 **베스트샷 레이캐스트가 주력**(1샷이면 표면 적중점이 나옴). **삼각측량은 가림(occlusion) 의심일 때만 보정**: 베스트샷 광선이 중간 벽을 맞았을 가능성(적중점이 다시점 수렴점과 0.6 m↑ 어긋남 + 수렴 RMS<0.35 m)에 한해 수렴점 채택. 신뢰도 배지는 `삼각측량 ±{RMS×100}cm` 로 표기. [L600–603]

> **RMS**(Root-Mean-Square, 평균제곱근) = 여러 광선이 한 점에 얼마나 잘 모였는지의 오차. 작을수록 수렴이 정확.

### 3.4 산출물: hotspots JSON

```jsonc
// public/data/<room>-hotspots.json  (예: living_room — 실제 Azure 산출물)
{ "generatedBy": "personal-room-scanner-3d (Azure AI Vision, farthest-point coverage)",
  "hotspots": [
    {"slot":1,"object":"chair","detectedClass":"chair","confidence":0.82,"markerPosition":[1.215,0.673,-0.589]},
    {"slot":3,"object":"dining table","detectedClass":"dining table","confidence":0.75,"markerPosition":[1.314,0.74,0.043]},
    ...
  ]}
```

이 파일을 `memory-walk`가 **②계층 소스**로 로드(§5). `markerPosition`은 정규화 좌표계와 동일(가로 7.2·바닥 0).

### 라이브 점검 결과 (실제 작동 확인)

| 점검 | 결과 |
|------|------|
| `/api/vision-config` | `{"azure": true}` — Azure 실제 구성 |
| `/api/detect`(빈 이미지) | Azure가 직접 거부("image size zero") = 호출 경로 활성 |
| 스캐너 페이지 | HTTP 200, 실제 좌표·confidence JSON 산출 |

---

## 4. 비전 정밀 명명 (공통 — GLB 경로 입장 후)

좌표는 정확해도 이름(메쉬 라벨·기하 추정)은 틀릴 수 있다(예: 모델 라벨 `umbrella`인데 실제 화분). 그래서 **실제 렌더 픽셀을 스크린샷으로 찍어 멀티모달 LLM에 질의**한다.

### 4.1 이름 신뢰 하이브리드 (어디에 비전을 쓸지) [`isNamedMarker` L1270]

```js
var AMBIG_NAME_RE = /umbrella|parasol|kite|globe|\btoy\b|object|mesh|none|untitled|default/i;
function isNamedMarker(h){
  if (/^obj\d+$/.test(h.label) || h.label === "spot") return false;  // 기하 추정·합성 지점 → 비전
  if (AMBIG_NAME_RE.test(h.label)) return false;                     // 모호·오명명 → 비전이 판단
  return true;                                                       // 진짜 가구 이름 = 신뢰, 비전 제외
}
```

신뢰되는 이름(식탁·소파)은 비전이 덮지 않고, 비전은 `obj숫자`·`spot`·모호한 이름에만 작동 → 정확도 보존 + LLM 호출 절약.

### 4.2 배치 명명 — 4각도 (`/api/label-room`) [L1244–1305]

`captureLabelViews`가 번호 마커가 박힌 방을 **네 모서리 각도**(yaw = ±π/4, ±3π/4, fov 64)로 렌더 → `renderer.domElement.toDataURL("image/jpeg")` → `/api/label-room`(GPT‑4.1 비전)이 `{번호: 한글명}` 반환. 캐시 `mp_vision_labels:{glb}`.

### 4.3 사물별 정밀 — 오프스크린 클로즈업 (`/api/vision-label`) [`precisePointOffscreen` L1319]

가장 정확한 단계. 보이는 카메라를 건드리지 않고 각 마커를 정면 클로즈업으로 별도 렌더:

```js
const _offRT = new THREE.WebGLRenderTarget(512, 512);             // 오프스크린 렌더 타깃(텍스처)
_offCam.position.copy(clearViewPos(h.eye)); _offCam.lookAt(h.pos);
renderer.setRenderTarget(_offRT); renderer.render(scene, _offCam); // 화면이 아닌 텍스처에 렌더
renderer.readRenderTargetPixels(_offRT, 0,0, 512,512, buf);        // GPU→CPU 픽셀 리드백(+상하 반전)
const v = h.pos.clone().project(_offCam);                          // 3D 마커 → NDC(-1..+1)
const sx = (v.x+1)/2, sy = (1 - v.y)/2;                            // NDC → 화면 비율(0..1)
// (sx,sy) 둘레를 크롭 + 그 점에 빨간 십자선(crosshair) → '바로 이 점'만 보게
fetch("/api/vision-label", { body: JSON.stringify({ imageBase64: crop.toDataURL(...) }) });
// "없음"(중앙이 바닥/벽/빈 공간) → '빈 자리'로 처리(옆 큰 가구 오인 방지)
```

**투영(projection)**이 3D 좌표를 2D 크롭 좌표로 잇는 다리다. 십자선은 얇은 사물 뒤 큰 배경(커튼)으로 시선이 새는 것을 막는다. 캐시 `mp_vision_precise:{glb}`. 백엔드 폴백은 Azure Computer Vision(`/api/detect`).

---

## 5. 위치 관리 — 3계층 우선순위 + 영속화 [`resolveAnchorsThenPalace` L842]

개별 사물의 위치는 단일 소스가 아니라 **폴백 체인**으로 관리한다. 각 사물 = **앵커 레코드** `{ pos, label, ko, named, entityId, conf }`.

| 계층 | 소스 | 키 / 성격 |
|------|------|-----------|
| **① 사용자 편집** (최우선) | 마커 드래그·삭제·순서변경 | `localStorage["mw_edit:"+glb]`, `posMethod:"manual-edit"` — 사람이 좌표 확정 |
| **② 스캐너 hotspots** | 사진 + Azure Vision + 삼각측량(§3) | `<glb>-hotspots.json` — 무명·실사 방의 "측정형" 경로 |
| **③ GLB 기하** (폴백) | AABB 중심(§2) | 기본값. ①②가 없을 때만 |

- **공유 좌표계**: 세 소스 전부 가로 7.2·바닥 0 → 서로 갈아끼움 가능.
- **정체성(identity)**: 앵커는 `entityId`로 학습 개념에 바인딩 → 순서변경·이동·리로드에도 "이 사물 = 이 개념" 유지.
- **영속화**: 편집은 스캐너 JSON과 동일 형식으로 저장(`editJSON` L2464) → 리로드 시 ①계층 복원, 파일 내보내기로 ②계층 영구 반영 가능. 방 전체는 `palace.json` 직렬화.

---

## 6. 동선·표면 부착·카메라

### 6.1 동선 순서 — 최근접 이웃 + 진행방향 유지 [`designRoute` L1053 · 수식 L1116]

번호는 검출 순서가 아니라 **실제로 한 바퀴 도는 경로**로 매긴다.

```js
const turn  = (Δx/dist)*dirX + (Δz/dist)*dirZ;   // +1=직진, -1=뒤로(큰 회전)
const score = -dist + turn*0.7;                   // 가까움 우선 + 방향 유지(지그재그 억제)
```

이전의 "각도 스윕"(좌우 횡단)을 대체. 걷는 순서가 곧 학습 서사 순서가 된다.

### 6.2 표면 부착 — snapY (하향 레이캐스트) [L2124]

AABB 중심의 y는 허공일 수 있어(좌판 위 빈 공간), **y만** 표면에서 다시 잡는다.

```js
const rc = new THREE.Raycaster(new THREE.Vector3(x, bounds.max.y+0.6, z), new THREE.Vector3(0,-1,0));
return rc.intersectObjects(meshes)[0]?.point.y;   // 천장 위→바닥으로 쏴 첫 표면 높이
```

### 6.3 카메라 연속성 — clearViewPos [L1697]

마커 주변 28방향을 레이캐스트로 평가해, **트인 정도 + 방 중심 지향 + 직전 시선과의 정렬**을 점수화.

```js
const cont  = -(dir·curFwd);                                  // 현재 시선과 정렬될수록 +
const score = open*1.0 + facing*1.1 + dist*0.4 + cont*1.25;   // 연속성 가중 1.25 → 180° 휙 회전 억제
```

이동은 `flyTo`(easeInOutCubic 900 ms) 트윈, 트윈 중 `walk()`·`clampInsideRoom()` 생략으로 흔들림 제거.

---

## 7. 백엔드 API & LLM 구성 (`backend/app/main.py`)

| 엔드포인트 | 역할 | 모델/엔진 |
|------------|------|-----------|
| `GET /api/vision-config` [L283] | Azure Vision 구성 여부 | `{azure: bool}` |
| `POST /api/detect` [L486] | 단일 이미지 객체 검출 | **Azure Computer Vision** image analysis (objects + dense captions) |
| `POST /api/vision-label` [L365] | 크롭 1장 → 한국어 사물명 | **Azure OpenAI GPT‑4.1** 비전, 중앙 조준 프롬프트, `max_tokens 60`, `temp 0`, `json_object` |
| `POST /api/label-room` [L421] | 4각도(≤6장) + 번호 → `{번호:명}` | **GPT‑4.1** 비전, `max_tokens 700` |

`llm_chat_config` [L159–174]: Azure OpenAI 배포(`/openai/deployments/{dep}/chat/completions?api-version=...`)를 호출. **모델은 코드에 하드코딩되지 않고** `AZURE_OPENAI_DEPLOYMENT` 환경변수의 배포(이 서비스는 GPT‑4.1 배포를 사용)로 결정되며, 기본 API 버전은 gpt‑4.1을 지원하는 `2025-01-01-preview`. (Azure 미설정 시 OpenAI 폴백 기본 모델은 `gpt-4o-mini`.) 모든 비전 호출은 `temperature 0` + `response_format: json_object`로 결정적·파싱 안전.

---

## 8. 데이터 계약 (스키마)

**hotspots JSON** (스캐너 산출 / 편집 저장 공통)
```jsonc
{ "hotspots": [{
    "slot": 1, "object": "chair", "detectedClass": "chair",
    "confidence": 0.82, "markerPosition": [x, y, z],   // 정규화 좌표(가로 7.2·바닥 0)
    "posMethod": "raycast" | "triangulation" | "manual-edit",
    "entityId": "<학습개념 바인딩, nullable>"
}]}
```
**앵커(런타임)**: `{ pos: Vector3, label, ko, named, entityId, conf }` · **캐시 키**: `mp_vision_labels:{glb}`, `mp_vision_precise:{glb}`, `mw_edit:{glb}`, `lm_order:{slug}`.

---

## 9. 좌표 변환 총정리

| 변환 | 위치 | 수식 |
|------|------|------|
| 원본 → 방 좌표계 | memory-walk L714 | `scale = 7.2/max(x,z)`, 바닥 y=0 |
| 메쉬 → 3D 좌표 | L727·743 | `Box3.setFromObject().getCenter()` |
| 2D 검출 → 3D (스캐너) | scanner L571 | 레이캐스트 적중 / 삼각측량 수렴(RMS<0.5) |
| 3D → 2D 화면(NDC) | L1329 | `pos.project(camera)` → (-1..1) |
| NDC → 화면 비율 | L1329 | `sx=(v.x+1)/2`, `sy=(1−v.y)/2` |
| GPU 텍스처 → CPU 픽셀 | L1313 | `readRenderTargetPixels` + 상하 반전 |
| (x,z) → 표면 y | L2125 | 하향 레이캐스트 → `hit.point.y` |

---

## 10. 정확도·한계·검수(QA)

- **좌표 자체**: 경로 A는 무오차(읽기), 경로 B는 RMS로 정량화(±수 cm, 잘 수렴 시).
- **세그멘테이션**: 과분할은 병합으로 해결, **과병합(통짜 메쉬)은 기하학으론 불가** → 스캐너·손편집 계층으로.
- **AABB 중심 ≠ 표면/의미 중심**: snapY로 y 보정, XZ만 박스 중심. ㄱ자·불규칙 사물은 손편집 또는 (미적용)무게중심 방식 여지.
- **비전**: 얇은 사물 뒤 큰 배경에 약함 → 십자선 + '정밀' 버튼.
- **QA 절차**: `memory-walk.html?glb=<URL>&palace=<json>` 로드 → `window.__mwRoute`(번호·ko·pos) 확인, `window.__mpDetectReport`(count·byType·warn: sparse/skewed) 점검, 마커별 클로즈업 대조. 합격선: XZ 0.42 m 겹침 0 · 한 종류 과다 없음 · 동선 큰 점프(>3 m) 최소 · 천장/허공 마커 없음.

---

## 11. 용어집 (glossary)

| 용어 | 뜻 (쉽게) |
|------|-----------|
| **정규화(normalization)** | 방마다 다른 크기를 같은 척도(가로 7.2)로 맞추는 것. 거리 기준을 공유하려고. |
| **AABB(축 정렬 경계 상자)** | 사물을 감싸는, 축과 나란한 가장 작은 직육면체. 중심 = 사물 위치. |
| **레이캐스팅(raycasting)** | 한 점에서 광선을 쏴 처음 맞는 표면을 찾는 것. (스캐너 위치·snapY에 사용) |
| **삼각측량(triangulation)** | 여러 시점에서 같은 대상으로 쏜 광선이 만나는 점으로 3D 위치를 복원. 좌표가 없는 사진에 사용. |
| **RMS(평균제곱근 오차)** | 광선들이 한 점에 얼마나 잘 모였는지의 오차. 작을수록 정확. |
| **occlusion(가림)** | 앞 물체가 뒤 물체를 가려 광선이 엉뚱한 표면을 맞는 상황. 삼각측량 보정의 트리거. |
| **세그멘테이션(instance segmentation)** | "어떤 부분이 한 사물인가"를 가르는 것. 좌표가 아니라 그룹핑의 문제. |
| **NDC(정규화 장치 좌표)** | 3D 점을 카메라로 투영한 -1~+1 화면 좌표. 크롭·십자선 위치 계산에 사용. |
| **투영(projection)** | 3D 점을 2D 화면 좌표로 변환(`project`). 좌표↔스크린샷을 잇는 다리. |
| **오프스크린 렌더(WebGLRenderTarget)** | 화면이 아니라 메모리 텍스처에 그리기. 사용자 화면 안 건드리고 클로즈업 캡처. |
| **OWL-ViT** | 오픈 보캐뷸러리(임의 라벨) 이미지 검출 모델. Azure 미설정 시 브라우저 폴백. |
| **dense captions** | 이미지의 여러 영역마다 설명 문장을 다는 Azure Vision 기능. |
| **멀티모달 LLM** | 텍스트+이미지를 함께 이해하는 모델(여기선 GPT‑4.1 비전). |
| **method of loci(장소법)** | 익숙한 공간의 장소에 정보를 배치해 외우는 고전 기억술. 이 시스템의 학습 원리. |

---

*근거: `frontend/public/legacy/memory-walk.html`, `personal-room-scanner-3d.html`, `backend/app/main.py` (실제 소스) + 라이브 엔드포인트 점검. 친근한 버전은 `legacy/how-markers-work.html`, 시각화는 `legacy/bounding-box-visual.html`·`system-architecture.html`.*
