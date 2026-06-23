# TTS 음성 통합 가이드 (준비용 · 팀 결정 전)

도우미 챗봇의 **목소리 전환 / 속도(느리게·보통·빠르게)** 버튼과, 학습 카드의 **🔊 듣기** 버튼을 위한 코드. 공용 엔진은 `tts-controls.js`(전역 `window.mpTTS`).

> 현재 상태: `tts-controls.js` 생성 + `assistant.js`에 음성 칩 추가까지 완료. 아래 **2개(스크립트 로드, 엔드포인트)** 를 켜야 실제로 소리가 난다. 팀 결정 후 적용.

## 1. 스크립트 로드 (memory-walk.html 등 음성 쓸 페이지)
`assistant.js` 옆에 한 줄 추가하면 된다. (SDK는 `tts-controls.js`가 필요할 때 자동 로드하므로 굳이 안 넣어도 되지만, 미리 넣어두면 첫 재생이 빠름)

```html
<script src="tts-controls.js" defer></script>
<script src="assistant.js" defer></script>
```

## 2. 토큰 엔드포인트 지정 (중요 · 결정 필요)
브라우저가 `/api/speech-token`에서 10분짜리 토큰을 받아 Azure에 직접 말한다. **이 엔드포인트는 백엔드(graphrag, `3d-mindpalace-ai-backend`)에 있다.** 프론트와 백엔드 도메인이 다르면 기본값 `/api/speech-token`로는 못 찾으니, 페이지에서 절대 URL을 지정:

```html
<script>
  window.MP_TTS_TOKEN_URL = "https://3d-mindpalace-ai-backend.azurewebsites.net/api/speech-token";
</script>
```

- 같은 도메인(또는 프록시)으로 합쳐지면 이 줄은 생략 가능.
- 백엔드 CORS가 프론트 도메인을 허용해야 함(graphrag는 현재 `*` 허용).
- 그리고 백엔드 App Service에 `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` 환경변수가 설정돼 있어야 토큰이 발급된다.

## 3. 챗봇 버튼 — 이미 됨
`assistant.js`가 방(walk) 진입 시 음성 칩을 자동 노출한다:
`🔊 목소리: 여성` (누를 때마다 남↔여) · `느리게` · `보통` · `빠르게` · `▶ 미리듣기`.
설정은 `localStorage`에 저장돼 페이지 간 유지된다.

## 4. 학습 카드 '듣기' 버튼 (우측 정도전 카드 등)
카드 설명을 현재 설정(목소리·속도)으로 읽어준다. 카드를 그리는 코드에서 설명 텍스트 옆에 버튼을 추가:

```html
<button type="button" class="tts-listen" aria-label="설명 듣기"
        onclick="window.mpTTS && window.mpTTS.speak(this.dataset.text)"
        data-text="조선 건국의 주요 신진 사대부 인물로, 개혁과 국가 기틀 마련에 중추적 역할을 하였으며 군사 훈련과 정책 수립에 기여함">
  🔊 듣기
</button>
```

설명이 JS 변수로 들어오는 경우(동적 렌더)는 `data-text`에 그 변수를 넣으면 된다. 예(템플릿 리터럴):

```js
`<button type="button" class="tts-listen" aria-label="설명 듣기"
   onclick="window.mpTTS && window.mpTTS.speak(this.dataset.text)"
   data-text="${esc(node.description)}">🔊 듣기</button>`
```

> `data-text` 경유가 안전: 따옴표·특수문자가 onclick 문자열을 깨지 않는다. `tts-controls.js`가 내부에서 SSML용으로 한 번 더 이스케이프한다.

## 5. 공간음향 (좌/우/중앙) + 스크린 리더 라벨
- 챗봇에 `🎧 공간음향 켜기/끄기` 칩이 자동으로 뜬다(방 walk). 설정은 저장돼 유지.
- ON 이면 `speak(text, {pan})` 의 `pan`(-1 왼 ~ +1 오)에 따라 좌우로 들린다. OFF면 항상 가운데.
- **상하(높이) 구분은 일반 기기에서 지각이 어려워 제외** — 수평만 지원.

**듣기 버튼 aria-label = 공간음향 상태 반영(스크린 리더용):**
공간음향이 켜져 있으면 듣기 버튼이 "공간음향 듣기"로 읽히게 한다. 버튼을 그릴 때 `window.mpTTS.listenLabel()` 로 aria-label 을 설정:

```js
var lbl = (window.mpTTS && window.mpTTS.listenLabel) ? window.mpTTS.listenLabel() : "듣기";
// `<button ... aria-label="${lbl}" ...>🔊 듣기</button>`
```

**memory-walk 에서 pan 넘기기(사물 좌우 위치):**
활성 핫스팟의 좌우 위치를 카메라 기준으로 환산해 `pan`으로 넘긴다. Three.js 카메라가 있으면 대략:

```js
// objPos: 사물 THREE.Vector3, camera: 현재 카메라
var toObj = objPos.clone().sub(camera.position).normalize();
var right = new THREE.Vector3(); camera.getWorldDirection(new THREE.Vector3()); // 방향
right.crossVectors(camera.up, toObj.clone().multiplyScalar(-1)); // 대략적 좌우축
var pan = Math.max(-1, Math.min(1, toObj.dot(camera.right || right))); // -1~+1
window.mpTTS.speak(desc, { pan: pan });
```
> 정확한 좌우축은 memory-walk 의 카메라 right 벡터(`entryFrame`/카메라 행렬)에서 가져오는 게 정밀하다. 위는 근사 예시 — 실제 좌우축 변수에 맞춰 1줄만 바꾸면 된다.

## 6. (선택) 아무 곳에나 컨트롤 버튼 박기
```js
window.mpTTS.renderControls(document.getElementById("myContainer"));
```
> 주: renderControls 는 목소리·속도 4버튼만 그린다(공간음향 토글은 챗봇 칩에서). 필요하면 확장 가능.

## 동작 안 할 때 점검
1. 콘솔에 `[mpTTS]` 에러 → 토큰 발급 실패(엔드포인트/CORS/환경변수) 또는 SDK 로드 실패.
2. `window.mpTTS` 가 undefined → `tts-controls.js` 가 로드 안 됨.
3. 토큰은 받는데 무음 → 음성 이름 오타(`...:DragonHDLatestNeural`) 또는 리전 음성 미지원. Voice Gallery에서 정확 표기 확인.
