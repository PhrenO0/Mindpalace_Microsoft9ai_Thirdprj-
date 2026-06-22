# 3D 위치 파악 · 좌표 계산 · 스크린샷 · 객체 인식 — 정밀 기술 문서

> 대상: 나(개발/발표 준비용). 공개용 토스 페이지(`legacy/how-markers-work.html`)와 달리, 여기서는 **실제 코드·수식·좌표 변환을 한 줄씩** 설명한다.
> 근거 파일: [`frontend/public/legacy/memory-walk.html`](frontend/public/legacy/memory-walk.html), [`backend/app/main.py`](backend/app/main.py).
> 모든 함수명·라인 번호는 실제 소스 기준. "어떻게 위치를 파악하고, 스크린샷을 찍어 좌표를 잡고, 객체를 인식하는가"를 데이터가 흐르는 순서대로 따라간다.

---

## 0. 한눈에 — 데이터가 흐르는 7단계

```
GLB 다운로드
  │
  ├─① 정규화      모델을 "가로 7.2 / 바닥 y=0 / 중심 원점"으로 통일       → loader.load onLoad (L703~717)
  ├─② 위치·검출   각 메쉬의 바운딩박스 중심 = 3D 좌표. 이름패스+기하패스   → (L726~768)
  ├─③ 이름짓기    이름신뢰 → 그대로 / 애매·무명 → 비전(스크린샷+GPT)      → visionLabelRoom·autoPrecision (L1283~1375)
  ├─④ 겹침정리    3D 디클러스터 + 바닥평면(XZ) 0.42m 중복 제거            → designRoute ⓪ (L1056~1064)
  ├─⑤ 동선·배치   최근접 이웃 + 진행방향 유지로 걷는 순서 결정            → designRoute ④ (L1103~1124)
  ├─⑥ 마커 자리   표면 바로 위로 snapY(레이캐스트 down)                   → snapY (L2124)
  └─⑦ 카메라      마커마다 트인 시점 + 시선 연속성                        → clearViewPos (L1697)
```

좌표는 **단 한 번** ①에서 정해지는 "방 좌표계"를 끝까지 공유한다. 스캐너(`personal-room-scanner-3d`)가 만든 핫스팟 JSON과도 같은 좌표계(가로 7.2·바닥 0)라서 서로 호환된다.

---

## 1. 좌표계 — "방 좌표계"란 무엇인가

three.js 월드 좌표(단위 = 미터처럼 다루지만 실제론 무차원)에서:

| 축 | 의미 | 방향 |
|----|------|------|
| **x** | 바닥 평면 좌우 | 수평 |
| **z** | 바닥 평면 앞뒤 | 수평 |
| **y** | 높이 | 위(+) |

- **바닥 = y 0**, 천장 = y `roomH`.
- **가로(x·z 중 더 긴 쪽) = 7.2**. 이게 "기준 폭 7.2"의 정체다 — 물리 상수가 아니라, **모든 방을 같은 크기 자로 재기 위한 정규화 단위**. 방 스캐너도 같은 값을 쓰기 때문에 두 시스템의 좌표가 호환된다.
- 원점(0,0)은 방의 **수평 중심**.

GLB마다 제작자가 쓴 단위(cm·inch·임의 스케일)가 제각각이라, 이걸 통일하지 않으면 "0.5m 떨어진 의자"의 0.5가 방마다 다른 뜻이 된다. ①에서 한 번 정규화하면 그 뒤 모든 거리 임계값(0.42m, 0.6m, 0.5m…)이 **모든 방에서 동일한 물리적 의미**를 갖는다.

---

## 2. ① 정규화 — 좌표계를 세우는 수식

[`memory-walk.html` L703~717](frontend/public/legacy/memory-walk.html#L703-L717):

```js
const all = []; model.traverse(c => { if (c.isMesh) all.push(c); });
const backs = findBackdrops(all);                 // 스카이박스·배경 평면(방 크기 오염원) 식별

// 배경 제외한 "실제 방"만으로 바운딩박스
const rbox = new THREE.Box3();
all.forEach(m => { if (!backs.has(m)) rbox.expandByObject(m); });

const size   = rbox.getSize(new THREE.Vector3());     // 방의 가로·세로·높이(원본 단위)
const center = rbox.getCenter(new THREE.Vector3());
const scale  = 7.2 / Math.max(size.x, size.z, 0.001); // ← 가로 긴 쪽을 7.2로

model.scale.setScalar(scale);                         // 1) 균일 축소/확대
model.position.set(-center.x*scale,                   // 2) x 중심 → 0
                   -rbox.min.y*scale,                 //    바닥(min.y) → 0
                   -center.z*scale);                  //    z 중심 → 0
model.updateMatrixWorld(true);
```

세 줄이 핵심이다:
1. `scale = 7.2 / max(가로, 세로)` → 모든 방을 같은 가로폭으로.
2. `setScalar(scale)` → 모델 전체를 그 비율로 균일 변환(가구 비율 유지).
3. `position.set(…)` → 평행이동. **바닥을 정확히 y=0에, 수평 중심을 원점에** 맞춘다. `rbox.min.y`(가장 낮은 점)에 scale을 곱한 값을 빼므로 바닥이 0으로 내려온다.

이후 쓰는 `roomH = size.y * scale`(L738)가 정규화된 방 높이. 모든 "키 큰 가구 / 천장 부착물" 판정이 이 `roomH` 비율로 이뤄진다.

> **배경(backdrop) 제외가 왜 중요한가**: 박물관 GLB는 종종 거대한 스카이박스 평면을 갖는다. 이걸 포함해 바운딩박스를 재면 "방"이 수백 미터로 잡혀 scale이 터무니없어진다. `findBackdrops`로 걸러 **진짜 방 메쉬만**으로 크기를 잰다.

---

## 3. ② 위치 파악 — 사물의 3D 좌표는 어떻게 나오는가

핵심 원리는 단순하다: **각 사물(메쉬)의 바운딩박스 중심 = 그 사물의 3D 좌표(anchor.pos)**.

```js
const b = new THREE.Box3().setFromObject(mesh);   // 메쉬를 감싸는 최소 직육면체(월드 좌표)
const pos = b.getCenter(new THREE.Vector3());      // 그 박스의 중심점 = 사물 위치
```

`Box3.setFromObject`는 메쉬의 모든 정점을 월드 변환(정규화 포함)한 뒤 최소·최대를 잡는다. 그 한가운데가 곧 "이 사물이 방 어디에 있는가"다. 위치 파악에 AI가 필요 없다 — **기하학(정점 좌표)만으로 정확**하다. AI는 "이게 무엇인가(이름)"에만 쓴다(③).

검출은 **두 패스**로 사물을 모은다.

### 2-A. 이름 패스 (믿을 수 있는 이름이 있을 때)

[L726~729](frontend/public/legacy/memory-walk.html#L726-L729):

```js
const FURN_RE = /Factory|Sofa|Couch|Cabinet|Table|Desk|Chair|Seat|Bed|Lighting|Lamp|
                 Shelf|Stand|Bookcase|Wardrobe|Stool|Plant|Dresser|Bench|Nightstand|
                 Vase|Jar|Bowl|Candle|window|sink|carpet|painting/i;

if (c.name && FURN_RE.test(c.name) && !/^None/i.test(c.name)) {
  const b = new THREE.Box3().setFromObject(c);
  const lb = (c.name.match(FURN_RE) || ["object"])[0].toLowerCase();
  anchors.push({ pos: b.getCenter(…), name: c.name, label: lb, ko: furnKO(lb), named: true });
}                                          //                                  ↑ 이름 신뢰 표시
```

메쉬 이름이 `"Sofa_01"`, `"dining Table"`처럼 실제 가구 단어를 포함하면 → 그 이름을 **신뢰**(`named:true`)하고, 위치는 바운딩박스 중심.

### 2-B. 기하 패스 (이름이 없거나 명명규칙이 다른 GLB)

[L734~768](frontend/public/legacy/memory-walk.html#L734-L768). 이름표가 없는 GLB(벽이 `"Object_4"`, `"Cube"`)도 인식하려고, **모든 메쉬를 형태로 거른다**:

```js
const roomMax = 7.2, roomH = size.y * scale;
model.traverse(c => {
  if (STRUCT_RE.test(c.name)) return;                       // 이름이 구조물이면 제외
  const b = new THREE.Box3().setFromObject(c);
  const s = b.getSize(new THREE.Vector3()), maxd = Math.max(s.x,s.y,s.z);

  // ── 크기 게이트 ──
  if (maxd < roomMax*0.03 || maxd > roomMax*0.92) return;   // 너무 작음(소품)·너무 큼(구조물)

  // ── 모양 게이트(이름 없는 벽·바닥도 형태로 판별) ──
  const thin = Math.min(s.x,s.z), wide = Math.max(s.x,s.z);
  if (thin < roomMax*0.028 && (s.y > roomH*0.45 || wide > roomMax*0.30)) return; // 얇고 큰 면=벽
  if (s.y < roomMax*0.012 && wide > roomMax*0.45) return;                         // 납작·거대=바닥/천장
  if (s.y > roomH*0.82  && wide > roomMax*0.12) return;                           // 전체높이=벽/기둥

  const ctr = b.getCenter(new THREE.Vector3());
  if (ctr.y > roomH*0.72) return;                            // 천장 부착물(조명·실링팬) 제외

  cand.push({ pos: ctr, vol: s.x*s.y*s.z,
              ko:  inferFurnLabel(c) ? furnKO(inferFurnLabel(c)) : null,  // 계층 이름에서 추론
              geo: geomGuess(s, ctr.y, roomH) });            // 이름 실패시 쓸 기하학 추정
});

cand.sort((a,b)=> b.vol - a.vol);          // 큰 가구 우선
const MINSEP = roomMax*0.07;               // ≈0.5m 안에 들어온 분할 메쉬는 하나로
for (const c of cand) {
  if (anchors.length >= 22) break;
  if (!anchors.every(a => a.pos.distanceTo(c.pos) > MINSEP)) continue;  // 공간 디클러스터
  anchors.push({ pos:c.pos, label:"obj"+(gi++), ko: c.ko||c.geo||"가구", named: !!c.ko });
}
```

여기서 위치는 여전히 **바운딩박스 중심(`ctr`)**. 게이트들은 "이게 가구냐 벽·바닥·천장이냐"를 **크기·비율·높이**로만 판정한다. 이름이 전혀 없어도 형태로 벽을 걸러낸다.

핵심 메타데이터 두 개:
- `label`: 내부 고유 키(`obj0`, `obj1`…). 병합·다양성 파이프라인용.
- `named`: **이름 신뢰 플래그**. 계층 이름에서 가구 종류를 찾았으면 `true`(비전 교정 제외), 순수 기하 추정(`geomGuess`)뿐이면 `false`(비전이 보강).

### 2-C. 이름 추론 두 방법

**(a) `inferFurnLabel`** [L1549](frontend/public/legacy/memory-walk.html#L1549) — 메쉬 + 부모 4단계 이름을 이어붙여 가구 사전(`FURN_KO`) 키를 찾는다. GLB는 보통 `Room > DiningSet > chair_03`처럼 계층에 단서가 있다:

```js
function inferFurnLabel(node){
  let s = " " + (node.name||"");
  let p = node.parent, hops = 0;
  while (p && hops < 4) { if (p.name) s += " " + p.name; p = p.parent; hops++; }  // 조상 4단계까지
  s = s.toLowerCase().replace(/[_\-.]+/g, " ");
  for (const k in FURN_KO) if (s.includes(k)) return k;     // 사전 매칭
  return null;
}
```

**(b) `geomGuess`** [L1561](frontend/public/legacy/memory-walk.html#L1561) — 이름이 정말 없을 때의 마지막 폴백. **정규화된 크기 비율**로 그럴듯한 가구명을 추정:

```js
function geomGuess(s, cy, roomH){
  const h = s.y, foot = Math.max(s.x,s.z), thin = Math.min(s.x,s.z), H = roomH;
  if (h < H*0.06 && foot > 1.2)              return "러그";   // 납작·넓게 깔림
  if (cy < H*0.30 && foot > 2.6 && h < H*0.45) return "침대"; // 바닥 가까이·아주 넓고 낮음
  if (cy < H*0.33 && foot > 1.6 && h < H*0.45) return "소파";
  if (h > H*0.55 && thin > 0.35 && foot > 0.6) return "수납장"; // 키 크고 깊이 있음
  if (h > H*0.45 && foot > 0.55 && thin < 0.5) return "책장";   // 키 크고 앞뒤 얇음(칸 면)
  if (h > H*0.45 && foot < 0.45 && thin < 0.4) return "스탠드"; // 양쪽 다 가는 기둥
  if (h > H*0.45)                            return "수납장";
  if (cy < H*0.46 && foot > 0.9 && h < H*0.36) return "테이블"; // 중간높이 평평한 상판
  if (cy < H*0.46 && foot <= 1.1)            return "의자";
  return "소품";
}
```

> `geomGuess`는 본질적으로 한계가 있다(넓은 선반↔책장↔스탠드 구분이 미묘). 그래서 ③의 비전이 **실제 픽셀**로 이걸 덮어쓴다. `geomGuess`의 목표는 "가구 N" 같은 숫자 대신 **자연스러운 임시 이름**을 주는 것뿐.

---

## 4. ③ 객체 인식 — 스크린샷을 찍어 AI로 이름을 정한다

②까지는 "위치(좌표)"는 정확하지만 "이름"은 메쉬 이름·기하 추정이라 틀릴 수 있다(예: 모델 라벨이 `umbrella`인데 실제론 화분). 그래서 **실제로 화면에 렌더한 픽셀을 스크린샷으로 찍어 GPT-4.1 비전에 보낸다.** 두 단계로 한다.

### 핵심: 이름 신뢰 하이브리드 (어디에 비전을 쓸지 결정)

[L1270~1276](frontend/public/legacy/memory-walk.html#L1270-L1276):

```js
var AMBIG_NAME_RE = /umbrella|parasol|kite|globe|\btoy\b|object|mesh|none|untitled|default/i;
function isNamedMarker(h){
  var lb = String(h.label||"");
  if (/^obj\d+$/.test(lb) || lb === "spot") return false;  // 기하 추정·합성 지점 → 비전
  if (AMBIG_NAME_RE.test(lb)) return false;                // 모호·오명명 이름 → 비전이 판단
  return true;                                             // 그 외 진짜 가구 이름 = 신뢰, 비전 제외
}
```

이게 "비전이 정확한 이름(식탁·소파)을 엉뚱하게 덮어쓰던" 문제의 해결책. **신뢰되는 이름은 비전이 건드리지 않고**, 비전은 `obj숫자`(기하 추정)·`spot`(합성 지점)·모호한 이름(umbrella 등)에만 작동한다. → 호출 절약 + 정확도 보존.

### 3-A. 배치 명명 — 4각도 방 사진 한 번에 (`/api/label-room`)

입장 직전 동기 1회. **번호 마커가 박힌 방을 네 모서리 각도로 찍어** GPT에게 "각 번호가 가리키는 게 뭐냐"를 한 번에 묻는다.

스크린샷 찍는 법 — `captureLabelViews` [L1244~1266](frontend/public/legacy/memory-walk.html#L1244-L1266):

```js
const eyeY  = bounds.min.y + clamp(sz.y*0.5, 1.4, 1.95);     // 눈높이
const yaws  = [PI/4, 3PI/4, -3PI/4, -PI/4];                  // 네 모서리 방향
const back  = 0.30 * Math.min(sz.x, sz.z);                   // 중심에서 뒤로 물러난 거리
camera.fov = 64;                                             // 넓게(많이 담기게)
yaws.forEach(yaw => {
  const dir = new THREE.Vector3(Math.sin(yaw), -0.14, Math.cos(yaw)).normalize();  // 살짝 내려봄
  const eye = new THREE.Vector3(cx(center.x - dir.x*back), eyeY, cz(center.z - dir.z*back));
  camera.position.copy(eye); controls.target.copy(eye.clone().add(dir)); controls.update();
  renderer.render(scene, camera);                            // 그 각도로 1프레임 렌더
  shots.push(renderer.domElement.toDataURL("image/jpeg", 0.8));  // 캔버스 → base64 JPEG
});
```

`renderer.domElement.toDataURL(...)`이 곧 스크린샷 — **현재 그려진 WebGL 캔버스를 그대로 이미지로 추출**한다. 번호 구슬(스프라이트)도 같이 찍혀 GPT가 "몇 번이 어디"를 안다.

전송 — `visionLabelRoom` [L1283~1305](frontend/public/legacy/memory-walk.html#L1283-L1305):

```js
const r = await fetch("/api/label-room", { method:"POST",
  body: JSON.stringify({ images: shots,                       // 4컷
                         numbers: route.map(h=>h.number),     // 명명할 번호 목록
                         context: THEME.name }) });           // 방 주제(힌트)
// 응답 {labels:{"1":"소파","2":"책상"}} → applyVisionLabels(이름신뢰 마커는 건너뜀)
```

캐시 `mp_vision_labels:{glb파일명}`. 실패·타임아웃(38s)이면 기하 추정 이름 유지(무회귀).

백엔드 [`main.py` L421~479](backend/app/main.py#L421-L479) — Azure OpenAI **gpt-4.1** vision. system 프롬프트가 "번호 구슬이 **얹힌 실제 가구**를 보라, 애매하면 가장 가까운 가구, 모르면 그 번호 생략", `temperature:0`, `response_format: json_object`.

### 3-B. 사물별 정밀 — 오프스크린 클로즈업 (`/api/vision-label`) ★ 가장 정확

배치(4각도)는 사물이 작게 찍혀 약할 수 있다. 그래서 입장 후 **배경에서 비동기로**, 각 마커를 **정면 클로즈업으로 따로 렌더**해 한 사물씩 정밀 명명한다. 사물이 프레임을 꽉 채워 가장 정확하다.

이게 "스크린샷 → 좌표 → 객체 인식"의 정수다. `precisePointOffscreen` [L1319~1349](frontend/public/legacy/memory-walk.html#L1319-L1349):

```js
const W = 512, H = 512;
// 1) 오프스크린 렌더 타깃 + 임시 카메라(보이는 카메라는 건드리지 않음)
if (!_offRT) { _offRT = new THREE.WebGLRenderTarget(W,H);
               _offCam = new THREE.PerspectiveCamera(50, 1, 0.05, 200); }

// 2) 마커를 정면에서 보는 트인 시점에 임시 카메라를 두고 마커를 바라봄
const camPos = clearViewPos(h.eye);            // ⑦과 동일 — 막히지 않은 시점
_offCam.position.copy(camPos); _offCam.up.set(0,1,0); _offCam.lookAt(h.pos);
_offCam.updateMatrixWorld(true); _offCam.updateProjectionMatrix();

// 3) 화면이 아니라 텍스처(_offRT)에 렌더 → 사용자 화면 안 깜빡임
const prev = renderer.getRenderTarget();
renderer.setRenderTarget(_offRT); renderer.render(scene, _offCam); renderer.setRenderTarget(prev);
const full = _readOffToCanvas(W, H);           // 픽셀 읽어 캔버스로(아래)

// 4) ★ 3D 마커 좌표 → 2D 화면 좌표(투영)
const v  = h.pos.clone().project(_offCam);     // 월드 → NDC(-1..+1)
const sx = (v.x + 1) / 2, sy = (1 - v.y) / 2;  // NDC → 화면 비율(0..1). y는 뒤집힘

// 5) 마커 주변만 크롭(사물이 프레임을 꽉 채우게)
const half = Math.round(min(W,H)*0.36), cw = min(2*half,W), ch = min(2*half,H);
const x0 = clamp(sx*W - half, 0, W-cw), y0 = clamp(sy*H - half, 0, H-ch);
crop.drawImage(full, x0,y0,cw,ch, 0,0,cw,ch);

// 6) 크롭 안 '마커의 정확한 픽셀 위치'에 빨간 조준 십자선 → GPT가 옆 큰 가구로 새지 않게
const ccx = sx*W - x0, ccy = sy*H - y0;
cg.moveTo(ccx-cw*0.07, ccy); cg.lineTo(ccx+cw*0.07, ccy);   // 가로선
cg.moveTo(ccx, ccy-ch*0.07); cg.lineTo(ccx, ccy+ch*0.07);   // 세로선
cg.arc(ccx, ccy, cw*0.035, 0, 2PI);                          // 작은 원

// 7) 크롭 + 십자선을 GPT-4.1 비전에 → 한국어 한 단어
const r = await fetch("/api/vision-label", { method:"POST",
            body: JSON.stringify({ imageBase64: crop.toDataURL("image/jpeg",0.85) }) });
const lab = (j.configured && j.label) ? j.label.trim() : "";
if (/없음|모름|바닥|벽|천장|빈\s*공간/.test(lab)) return "없음";   // 중앙이 빈 곳 → '빈 자리'
return lab.slice(0,24);
```

**픽셀 리드백 + 상하 뒤집기** — `_readOffToCanvas` [L1311~1318](frontend/public/legacy/memory-walk.html#L1311-L1318). WebGL은 좌하단이 원점이라 캔버스(좌상단 원점)로 옮길 때 행을 뒤집어야 한다:

```js
const buf = new Uint8Array(W*H*4);
renderer.readRenderTargetPixels(_offRT, 0,0, W,H, buf);   // GPU 텍스처 → CPU RGBA 배열
for (let y=0; y<H; y++){ const sy = H-1-y;                // ← 상하 반전
  for (let x=0; x<W; x++){ const s=(sy*W+x)*4, d=(y*W+x)*4;
    img.data[d]=buf[s]; img.data[d+1]=buf[s+1]; img.data[d+2]=buf[s+2]; img.data[d+3]=255; } }
ctx.putImageData(img, 0,0);
```

오케스트레이션 — `autoPrecision` [L1350~1375](frontend/public/legacy/memory-walk.html#L1350-L1375): `todo = route.filter(h => !h.precise && !isNamedMarker(h))` — **이름 신뢰 사물은 제외**, 미정밀 + 비신뢰만. 순차(레이트리밋 300ms 간격)·중단가능(`pagehide`로 방 떠나면 `_autoStop`). `없음` → "빈 자리"(`emptySpot`). 캐시 `mp_vision_precise:{glb}` — 재입장 시 재호출 없음.

백엔드 [`main.py` L365~414](backend/app/main.py#L365-L414) — gpt-4.1 vision, system: "정중앙(빨간 십자선) **바로 그 위치** 사물만, 더 크거나 옆에 있는 가구 말고. 중앙이 바닥/벽/빈 공간이면 반드시 '없음'", `max_tokens:60`, `temperature:0`. Azure Computer Vision(`/api/detect`, 고정 어휘)은 폴백.

### 왜 십자선이 결정적인가
얇은 사물(화분) 앞에 큰 배경(커튼)이 있으면, 크롭만 보내면 GPT가 **면적이 큰 커튼**을 답한다. 마커의 정확한 투영 좌표(`ccx,ccy`)에 십자선을 그려 "이 점의 사물"로 **시선을 고정**하면, 중앙이 비면 "없음"을 답한다 → 옆 가구로 둔갑하지 않는다.

---

## 5. ④ 겹침 정리 — 같은 자리에 마커가 겹치지 않게

`designRoute` 시작부 [L1056~1064](frontend/public/legacy/memory-walk.html#L1056-L1064):

```js
// ⓪ 방 크기 비례 최소 간격(0.6~1.1m)으로 뭉친 마커 솎기 — 3D 거리 기준
const MIN_SEP = Math.min(1.1, Math.max(0.6, 0.10*Math.max(sz.x,sz.z)));
const decl0 = declusterAnchors(anchors, MIN_SEP);

// 추가: 바닥평면(XZ)에서 0.42m 안에 겹친 것 제거
const decl = [];
for (const a of decl0)
  if (decl.every(k => Math.hypot(k.pos.x-a.pos.x, k.pos.z-a.pos.z) >= 0.42)) decl.push(a);
```

**3D 거리만 보면** 바닥 러그(y낮음)와 벽 그림(y높음)이 같은 바닥자리에 있어도 높이차 때문에 안 걸러진다 → 위에서 보면 마커가 겹쳐 보임. 그래서 **XZ(바닥평면) 거리**로 한 번 더 솎는다. 0.42m로 좁게 잡아 카페·교실의 떨어진 의자(≥0.5m)는 보존하고, 진짜 겹친 것만 정리(가중치 높은 쪽 유지).

추가로 `mergeAnchors`(L797)는 **같은 label**이 1.0m 안이면 병합(수납장 분할 패널 여러 개 → 하나).

---

## 6. ⑤ 동선·배치 — 번호를 "걷는 순서"로 매긴다

마커 번호는 검출 순서가 아니라 **실제로 한 바퀴 도는 동선**으로 매긴다. `designRoute` ④ [L1103~1124](frontend/public/legacy/memory-walk.html#L1103-L1124):

```js
const remain = picked.slice(); const seq = [];
let cx = eye.x, cz = eye.z;       // 현재 위치 = 입장 지점
let dx0 = fwd.x, dz0 = fwd.z;     // 진행 방향(턴 억제용)
while (remain.length) {
  let bi = 0, best = -Infinity;
  for (let i=0; i<remain.length; i++) {
    const p = remain[i].a.pos;
    const ddx = p.x-cx, ddz = p.z-cz, dist = Math.hypot(ddx,ddz);
    const turn  = (ddx/dist)*dx0 + (ddz/dist)*dz0;   // +1=직진, -1=뒤로(큰 회전)
    const score = -dist + turn*0.7;                  // 가까움 우선 + 방향 유지
    if (score > best) { best = score; bi = i; }
  }
  const nx = remain.splice(bi,1)[0];                 // 가장 좋은 다음 지점 선택
  // 현재 위치·방향 갱신
  const np = nx.a.pos; const nd = Math.hypot(np.x-cx, np.z-cz);
  dx0 = (np.x-cx)/nd; dz0 = (np.z-cz)/nd; cx = np.x; cz = np.z;
  seq.push(nx);
}
```

**최근접 이웃 + 진행방향 유지**다. `score = -거리 + 0.7×방향유지`:
- `-dist`: 가까운 곳 먼저.
- `turn*0.7`: 지금 가던 방향을 계속 유지하면 가산점, 뒤로 꺾으면 감점 → **지그재그·방 횡단 억제**.

예전 "각도 스윕"(좌우로 훑기)은 1→13번이 방을 가로질러 왔다갔다했다. 최근접 경로로 바꾼 뒤 living 방 기준 큰 횡단 점프 3→1회, 총경로 ~26→17.9m로 줄어 **카메라가 한 바퀴 매끄럽게** 돈다. 걷는 순서가 곧 학습 서사 순서가 된다(L1182 근처: rank 순 = 동선 순).

배치 보강 — 가구가 학습 항목보다 적으면 [L1133~1150](frontend/public/legacy/memory-walk.html#L1133-L1150), **빈 바닥 격자가 아니라 검출된 실제 가구 곁(중심쪽 0.6~0.9m)**에 합성 '기억 지점'(`label:"spot"`)을 둔다(허공 마커 방지). 가구가 0개일 때만 격자 폴백.

---

## 7. ⑥ 마커 자리 — 표면 바로 위에 띄운다

`snapY` [L2124~2129](frontend/public/legacy/memory-walk.html#L2124-L2129):

```js
function snapY(x, z) {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, bounds.max.y+0.6, z),  // 천장 위에서
                                 new THREE.Vector3(0,-1,0));                  // 똑바로 아래로
  const hit = rc.intersectObjects(meshes, false)[0];
  return hit ? hit.point.y : bounds.min.y + 0.8;     // 첫 충돌 표면의 y(없으면 기본 높이)
}
```

(x,z)는 ②의 바운딩박스 중심에서 가져오고, **y만** 레이캐스트로 다시 잡는다. 천장 위에서 바닥으로 광선을 쏴 **처음 맞은 표면**(식탁 상판·선반·바닥)의 높이를 얻어, 마커를 그 표면 **바로 위에 살짝** 띄운다. 그래서 마커가 사물 속에 박히거나 허공에 뜨지 않는다.

---

## 8. ⑦ 카메라 — 마커마다 "잘 보이고 안 휙 도는" 시점

`clearViewPos` [L1697~1731](frontend/public/legacy/memory-walk.html#L1697-L1731). 마커 주변 28방향을 돌며 레이캐스트로 "트인 정도"를 재고, **방 중심을 향하면서 + 현재 시선과 덜 꺾이는** 시점을 점수로 고른다:

```js
const N = 28;
for (let k=0; k<N; k++){
  const ang = (k/N)*2PI, dir = new THREE.Vector3(Math.cos(ang),0,Math.sin(ang));
  _viewRay.set(from, dir);
  const open = hit ? hit.distance : (want+0.8);      // 이 방향으로 트인 거리
  if (open < minD+margin) continue;                  // 너무 막힘 → 후보 제외
  const facing = dir.dot(facingRef);                 // +1=방 중심 향함
  const cont   = hasCur ? -(dir.x*curFwd.x + dir.z*curFwd.z) : 0;  // 현재 시선과 정렬
  const score  = open*1.0 + facing*1.1 + dist*0.4 + cont*1.25;     // ← 연속성 가중 1.25
  …
}
```

- `open`: 그 방향으로 벽까지 트인 거리(레이캐스트). 막힌 데서 안 본다.
- `facing`: 방 중심을 향하면 가산 → 벽에 코박지 않음.
- `cont`(연속성): **직전 카메라 시선과 정렬될수록** 가산 → 다음 마커로 갈 때 **180° 휙 도는 것 억제**. 가중치 1.25로 가장 큰 영향.

이동 자체는 `flyTo`(easeInOutCubic 900ms)로 트윈하고, 트윈 중엔 `walk()`·`clampInsideRoom()`을 생략해 흔들림을 없앤다. `losClear`(L1733)로 카메라→마커 직선이 다른 메쉬에 막히지 않는지 최종 확인.

---

## 9. 좌표 변환 총정리 — 어디서 어떤 변환이 일어나나

| 변환 | 위치 | 수식 | 쓰임 |
|------|------|------|------|
| 원본 → 방 좌표계 | L714~716 | `scale = 7.2/max(x,z)`, 바닥 y=0 | 모든 좌표의 기준 |
| 메쉬 → 3D 좌표 | L727·743 | `Box3.setFromObject().getCenter()` | 사물 위치 |
| 3D → 2D 화면(NDC) | L1329 | `pos.project(camera)` → `(-1..1)` | 크롭·십자선 위치 |
| NDC → 화면 비율 | L1329 | `sx=(v.x+1)/2`, `sy=(1-v.y)/2` | 크롭 중심 |
| GPU 텍스처 → CPU 픽셀 | L1313~1316 | `readRenderTargetPixels` + 상하반전 | 스크린샷 추출 |
| (x,z) → 표면 y | L2125 | 레이캐스트 down → `hit.point.y` | 마커 높이 |

투영(`project`)은 ②의 3D 좌표를 비전 단계의 2D 크롭 좌표로 잇는 다리다. **위치는 3D에서 정해지고, 인식은 그 3D 점을 2D로 투영한 자리의 픽셀로** 한다 — 이 왕복이 "좌표 ↔ 스크린샷"의 핵심.

---

## 10. 함수·파일 빠른 지도

| 단계 | 함수 | 파일·라인 |
|------|------|-----------|
| ① 정규화 | `loader.load` onLoad | memory-walk L703~717 |
| ② 이름 검출 | (인라인) `FURN_RE` | L726~729 |
| ② 기하 검출 | (인라인) 게이트 + `cand` | L734~768 |
| ② 이름 추론 | `inferFurnLabel` / `geomGuess` | L1549 / L1561 |
| ② 병합 | `mergeAnchors` | L797 |
| ③ 신뢰 판정 | `isNamedMarker` / `AMBIG_NAME_RE` | L1270 |
| ③ 배치 명명 | `captureLabelViews` → `visionLabelRoom` | L1244 / L1283 |
| ③ 정밀 명명 | `precisePointOffscreen` / `_readOffToCanvas` / `autoPrecision` | L1319 / L1311 / L1350 |
| ④ 겹침 정리 | `declusterAnchors` + XZ 0.42m | L1022 / L1063 |
| ⑤ 동선 | `designRoute` | L1053 |
| ⑥ 표면 부착 | `snapY` | L2124 |
| ⑦ 카메라 | `clearViewPos` / `losClear` / `flyTo` | L1697 / L1733 |
| 백엔드 비전 | `vision_label` / `label_room` / `detect_objects` | main.py L365 / L421 / L486 |

---

## 11. 검수(QA) 방법 — 내가 직접 확인할 때

1. `memory-walk.html?glb=<GLB_URL>&palace=public/data/korean_history.palace.json` 로드.
2. 콘솔 `window.__mwRoute` 또는 `window.__mw.route` — 각 항목의 `number·ko·pos`(좌표) 확인.
3. `window.__mpDetectReport` — `{count, byType, warn}`. `warn`이 `sparse`(<4개)·`skewed(>5)`이면 검출 편중 의심.
4. 각 마커 클로즈업으로 사물 대조 — 라벨과 실제 픽셀이 맞는지.
5. 체크: **XZ 0.42m 겹침 0** · **한 종류 과다 없음** · **동선 큰 점프(>3m) 최소** · 천장/허공 마커 없음.

### 알려진 한계
- 비전은 **얇은 사물 앞 큰 배경**(커튼 등)에 약할 수 있음 → 십자선으로 완화, 그래도 틀리면 그 마커만 "정밀" 버튼으로 즉석 재인식.
- `geomGuess`(모양 추측)는 본질적 한계 — 근본 정확도는 비전(자동) + 정밀 버튼이 담당.
- `named:true`(신뢰 이름)는 비전이 안 덮으므로, GLB가 **확신에 차서 틀린 이름**을 줬다면(예: 진짜 식탁을 `Sofa`로) 신뢰 때문에 안 고쳐짐 → 그런 단어를 `AMBIG_NAME_RE`에 추가해 비전이 판단하게 하면 된다.
