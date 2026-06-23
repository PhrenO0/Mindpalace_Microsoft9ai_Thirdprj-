# 퀴즈 생성 버튼 트러블슈팅

대상 파일: [`quiz-widget.js`](../quiz-widget.js), 호스트 페이지: [`vworld_map.html`](../vworld_map.html)
작성일: 2026-06-23

---

## 공통 배경

호스트 페이지 `vworld_map.html`는 `window`에 전역 키보드 핸들러를 달고 있다 (`vworld_map.html:2120-2137`):

```js
window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") { stopTour(false); flyToAnchor(activeIndex + 1); }
  if (event.key === "ArrowLeft")  { stopTour(false); flyToAnchor(activeIndex - 1); }
  if (event.key === "Enter")      { enterCurrentStop(); }      // 현재 정거장(방)으로 진입
  if (event.code === "Space")     {
    event.preventDefault();                                    // 스페이스 입력 자체를 막음
    labelsHidden = !labelsHidden;
    renderUi();                                                // 오른쪽 카드 다시 그림
  }
});
```

퀴즈 위젯의 주제 입력칸 `#qzTopic` (`quiz-widget.js:123`)은 키 이벤트의 전파를 막지 않아, 입력칸에서 누른 키가 그대로 `window` 전역 핸들러까지 버블링된다.

> 참고: 챗봇 입력칸은 `assistant.js:332-334`에서 이미 `e.stopPropagation()`으로 같은 문제를 막고 있다. 퀴즈 위젯만 누락되어 있었다.

---

## 버그 1 — 주제 입력 후 Enter → 임의의 방으로 이동

- **증상:** 퀴즈 생성 팝업에서 주제를 입력하고 Enter를 누르면 임의의 방으로 이동.
- **원인:** 입력칸의 Enter 키가 전역 핸들러로 전파되어 `enterCurrentStop()`이 호출됨 (`vworld_map.html:2129-2130`). 현재 활성 정거장(`activeIndex`)으로 진입하는 것이라 사용자에겐 "임의의 방"으로 보인다. 위젯에는 Enter=제출 같은 핸들러가 없어 그대로 새어 나간다.
- **수정 위치:** `quiz-widget.js` — `renderQuizSetup()`의 `#qzTopic` 입력칸.

## 버그 2 — "퀴즈 만들기" 클릭 시 404

- **증상:** "퀴즈 기능이 아직 백엔드에 연결되지 않았어요 (404). graphrag에 /quiz/json 추가 후 작동합니다." 에러.
- **원인: 엔드포인트·URL은 정상이고, 위젯이 보내는 `snapshot` 키가 graphrag에 등록되어 있지 않아서다.**
  - `quizBase()`(`quiz-widget.js:16-18`)가 가리키는 `https://3d-mindpalace-ai-backend-...canadacentral-01.azurewebsites.net`는 코드베이스 전반에서 쓰이는 **graphrag 백엔드(GRAPHRAG_BASE)** 그 자체다 (`region-select.html:220`, `home.html:7088`의 `/orchestrator/upload` 대상과 동일). → URL은 맞다.
  - `/quiz/json` 라우트도 graphrag에 등록·**배포되어 있다** (`graphrag/backend/app.py:164`, `graphrag/backend/quiz/quiz_json.py`). 실제 배포 서버에 `snapshot:"korean_history"`로 `POST /quiz/json` 하면 **200**으로 정상 퀴즈가 온다(확인 완료).
  - 진짜 원인: `snapshotKey()`(`quiz-widget.js:19-24`)의 폴백 순서가 `cfg().snapshot → mp_rag_job.jobId → ?city → "korean_history"`인데, **`?city`(지도용 도시 슬러그, vworld_map 기본 `"jongno"`)를 snapshot으로 보낸다.** graphrag에 등록된 스냅샷은 `korean_history`·`statistics`(+ 라이브 잡 `jobId`)뿐이라, `jongno` 같은 슬러그는 `_builder_for`가 해석하지 못하고 `quiz_json.py:133-137`이 `HTTPException(404, "스냅샷 '...' 을(를) 찾을 수 없습니다")`를 던진다. (배포 서버에 `snapshot:"seoul_jongno_xyz"`로 호출 → 404 재현 확인.)
  - 위젯 주석·에러 메시지(`quiz-widget.js:13-15, 151`)는 "graphrag에 /quiz/json 추가 후 작동"이라고 하지만, 라우트는 이미 있으므로 **메시지가 구식·오해 소지**가 있다.
- **수정 위치:** `quiz-widget.js`
  - `snapshotKey()` — `?city` 폴백 제거(도시 슬러그 ≠ RAG 스냅샷). 폴백: `cfg().snapshot → mp_rag_job.jobId → "korean_history"`.
  - `generateQuiz()` 응답 처리 — 비정상 응답 시 서버의 실제 `detail` 메시지를 표시(구식 안내문 교체).

## 버그 3 — 주제에 스페이스 입력 시, 띄어쓰기 안 되고 오른쪽 카드(경복궁 등)가 접혔다 펴짐

- **증상:** 주제 입력칸에서 스페이스를 누르면 공백이 입력되지 않고, 오른쪽 카드가 접혔다 펴진다.
- **원인:** 버그 1과 동일하게 Space 키가 전역 핸들러로 전파됨 (`vworld_map.html:2132-2136`).
  - `event.preventDefault()` 때문에 입력칸에 공백 문자가 들어가지 않고,
  - `labelsHidden` 토글 + `renderUi()` 재렌더 때문에 오른쪽 카드가 접혔다 펴진다.
- **수정 위치:** 버그 1과 동일 (`#qzTopic` 키 전파 차단).

---

## 원인 요약

| 버그 | 근본 원인 | 수정 위치 |
|---|---|---|
| 1. Enter→방 이동 | `#qzTopic` 키 이벤트가 전역 핸들러로 전파 | `quiz-widget.js` 입력칸 키 핸들링 |
| 2. 404 | `snapshotKey()`가 미등록 도시 슬러그(`?city=jongno`)를 snapshot으로 전송(URL·엔드포인트는 정상) | `quiz-widget.js` `snapshotKey()`·에러 표시 |
| 3. Space 미입력·카드 토글 | 동일(전역 핸들러의 `preventDefault`+`renderUi`) | `quiz-widget.js` 입력칸 키 핸들링 |

버그 1·3은 같은 뿌리(키 이벤트 전파 미차단)다.

---

## 수정 계획

### 1) 키 이벤트 전파 차단 (버그 1·3)

`quiz-widget.js`의 모달 입력칸에서 키 이벤트가 호스트 페이지로 새어 나가지 않게 한다.

- 모달 컨테이너(또는 `quizBody`)에 `keydown`/`keyup`/`keypress` 리스너를 달아 `e.stopPropagation()` 호출 — 모달이 열린 동안 모든 입력칸/버튼에 일괄 적용되어 가장 견고하다.
- 추가로 주제 입력칸에서 Enter를 누르면 자연스럽게 "퀴즈 만들기"가 실행되도록 한다(`generateQuiz()` 호출). 한글 IME 조합 중 Enter 오작동 방지를 위해 `e.isComposing`/`keyCode 229` 가드를 둔다 (`assistant.js`와 동일 패턴).

### 2) snapshot 폴백 교정 + 에러 표시 개선 (버그 2)

- `snapshotKey()`에서 `?city` 폴백을 제거한다. 도시 슬러그(`jongno`)는 지도 식별자일 뿐 graphrag 스냅샷이 아니므로 보내면 404가 난다. 폴백은 `cfg().snapshot → mp_rag_job.jobId → "korean_history"`(항상 존재하는 데모 스냅샷)로 둔다. 업로드한 PDF가 있으면 그 `jobId`가 우선되어 사용자 자료로 퀴즈가 나간다.
- `generateQuiz()`의 비정상 응답 처리에서 응답 본문의 `detail`(서버가 주는 한국어 설명)을 함께 표시해, "graphrag에 /quiz/json 추가…"라는 구식·오해 메시지를 교체한다.
- (참고) `quizBase()`/`MP_QUIZ_BASE`는 이미 graphrag 백엔드를 가리키므로 변경하지 않는다.

---

## 적용된 수정 (구현 완료)

모두 [`quiz-widget.js`](../quiz-widget.js) 한 파일에서 처리. `node --check` 구문 검사 통과.

### ① 모달 키 이벤트 격리 (버그 1·3) — `ensureDom()`

모달 컨테이너에서 키 이벤트 전파를 끊어, 호스트 전역 단축키(Enter=정거장 진입, Space=`preventDefault`+라벨 토글+재렌더)로 새지 않게 한다.

```js
$("quizModal").addEventListener("click", function (e) { if (e.target === $("quizModal")) $("quizModal").style.display = "none"; });
// 모달 안에서 친 키(스페이스·엔터 등)가 호스트 페이지의 전역 단축키로 새어 나가지 않게 막는다.
["keydown", "keyup", "keypress"].forEach(function (evt) {
  $("quizModal").addEventListener(evt, function (e) { e.stopPropagation(); });
});
```

### ② 주제 입력칸 Enter → 퀴즈 생성 (버그 1 보강) — `renderQuizSetup()`

```js
// 주제 입력 후 Enter 는 '퀴즈 만들기'로 연결(한글 IME 조합 중 Enter 오발 방지).
$("qzTopic").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); generateQuiz(); }
});
```

### ③ snapshot 폴백 교정 (버그 2) — `snapshotKey()`

`?city` 폴백 제거. 도시 슬러그는 graphrag 스냅샷이 아니므로 보내지 않는다.

```js
function snapshotKey() {
  if (cfg().snapshot) return cfg().snapshot;
  // ?city 는 지도용 도시 슬러그일 뿐 graphrag 스냅샷이 아니라서 폴백에 쓰지 않는다.
  try { var j = JSON.parse(localStorage.getItem("mp_rag_job") || "null"); if (j && j.jobId) return j.jobId; } catch (e) {}
  return "korean_history";
}
```

### ④ 비정상 응답 시 서버 detail 표시 (버그 2 보강) — `generateQuiz()`

```js
.then(function (r) {
  // 비정상 응답이어도 본문(JSON {detail})을 읽어 서버가 주는 실제 사유를 보여준다.
  return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
})
.then(function (res) {
  if (!res.ok) {
    var detail = res.body && res.body.detail ? esc2(res.body.detail) : "잠시 후 다시 시도해 주세요.";
    $("quizBody").innerHTML = '<div style="color:#b06a3a">퀴즈를 만들지 못했어요 (' + res.status + '). ' + detail + '</div>';
    quizBackBtn(); return null;
  }
  return res.body;
})
```

### 적용 결과 요약

| 버그 | 적용 함수 | 결과 |
|---|---|---|
| 1. Enter→방 이동 | `ensureDom()` + `renderQuizSetup()` | Enter가 호스트로 안 새고, 주제칸 Enter는 퀴즈 생성으로 연결 |
| 3. Space 미입력·카드 토글 | `ensureDom()` | 모달 안 Space 정상 입력, 카드 안 움직임 |
| 2. 404 | `snapshotKey()` + `generateQuiz()` | 미등록 슬러그 대신 `korean_history`/라이브 잡 전송, 실패 시 서버 사유 노출 |

### 남은 항목 (코드 아님 / 제품 결정 필요)

- 도시별(jongno 등) 전용 퀴즈가 필요하면 해당 도시를 graphrag에 스냅샷으로 인제스트하거나 호스트 페이지에서 `window.mpQuizConfig.snapshot`으로 매핑해야 한다. 현재는 데모(`korean_history`)로 동작.
- 브라우저에서 `/quiz/json` 호출 시 CORS는 azure(graphrag) 백엔드의 허용 오리진 설정에 달려 있다(프론트 코드 이슈 아님).
