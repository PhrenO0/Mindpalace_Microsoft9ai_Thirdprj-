/* 공유 퀴즈 위젯 — graphrag /quiz/json 생성 + /quiz/grade 채점 (백엔드 quiz.html 템플릿 대응).
   사용: <script src="quiz-widget.js" defer></script> 후 window.mpOpenQuiz() 호출(대시독 버튼·챗봇 등).
   설정(선택): window.mpQuizConfig = { snapshot, base, palaceId }.
     없으면 snapshot = mp_rag_job.jobId > ?city > "korean_history", base = mp_rag_job.base > 기본 백엔드. */
(function () {
  "use strict";
  if (window.__mpQuizWidget) return;
  window.__mpQuizWidget = true;

  function $(id) { return document.getElementById(id); }
  function esc2(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]; }); }
  function cfg() { return window.mpQuizConfig || {}; }
  function ragBase() {
    if (cfg().base) return cfg().base;
    try { var j = JSON.parse(localStorage.getItem("mp_rag_job") || "null"); if (j && j.base) return j.base; } catch (e) {}
    return window.MP_RAG_BASE || "https://3d-mindpalace-ai-backend-h3gze8h7hfhqg3h8.canadacentral-01.azurewebsites.net";
  }
  function snapshotKey() {
    if (cfg().snapshot) return cfg().snapshot;
    try { var j = JSON.parse(localStorage.getItem("mp_rag_job") || "null"); if (j && j.jobId) return j.jobId; } catch (e) {}
    try { var city = new URLSearchParams(location.search).get("city"); if (city) return city; } catch (e) {}
    return "korean_history";
  }
  function palaceId() {
    if (cfg().palaceId) return cfg().palaceId;
    try { return new URLSearchParams(location.search).get("city") || ""; } catch (e) { return ""; }
  }

  var MODAL_HTML =
    '<div id="quizModal" style="display:none;position:fixed;inset:0;z-index:9600;background:rgba(20,16,12,.55);backdrop-filter:blur(3px);">' +
    '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(600px,93vw);max-height:88vh;overflow:auto;' +
    'background:#fbf7f1;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.4);font-family:\'Pretendard\',\'Malgun Gothic\',sans-serif;">' +
    '<div style="display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid rgba(51,46,40,.12);position:sticky;top:0;background:#fbf7f1;z-index:2;">' +
    '<b id="quizHd" style="font-size:14.5px;color:#2a241d;flex:1;">📝 퀴즈</b>' +
    '<button id="quizClose" style="border:0;background:none;font-size:18px;cursor:pointer;color:#7a7066;">✕</button>' +
    '</div>' +
    '<div style="padding:14px 16px;">' +
    '<div id="quizBody" style="font-size:13.5px;line-height:1.6;color:#2a241d;"></div>' +
    '<div id="quizActions" style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;"></div>' +
    '</div></div></div>';

  var STYLE = [
    "#quizBody .qz-q{margin:0 0 14px;padding:14px 15px;border:1px solid rgba(51,46,40,.12);border-radius:13px;background:#fff;}",
    "#quizBody .qz-q:last-child{margin-bottom:0;}",
    "#quizBody .qz-qhead{display:flex;align-items:center;gap:8px;margin-bottom:9px;}",
    "#quizBody .qz-num{font-weight:900;font-size:13px;color:var(--accent,#b5552f);letter-spacing:.02em;}",
    "#quizBody .qz-badge{font-size:11px;font-weight:800;color:#7a7066;background:rgba(51,46,40,.07);border-radius:999px;padding:2px 9px;}",
    "#quizBody .qz-question{font-weight:700;font-size:14.5px;line-height:1.7;color:#2a241d;white-space:pre-line;margin-bottom:12px;word-break:keep-all;}",
    "#quizBody .qz-opts{display:flex;flex-direction:column;gap:8px;}",
    "#quizBody .qz-opt{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1.5px solid rgba(51,46,40,.16);border-radius:11px;cursor:pointer;font-size:13.5px;line-height:1.55;color:#2a241d;transition:border-color .12s,background .12s;word-break:keep-all;}",
    "#quizBody .qz-opt:hover{border-color:rgba(181,85,47,.5);background:rgba(181,85,47,.045);}",
    "#quizBody .qz-opt:has(input:checked){border-color:var(--accent,#b5552f);background:rgba(181,85,47,.1);font-weight:700;}",
    "#quizBody .qz-opt input{accent-color:var(--accent,#b5552f);width:16px;height:16px;flex:0 0 auto;margin:0;}",
    "#quizBody .qz-in{width:100%;box-sizing:border-box;padding:11px 13px;border:1.5px solid rgba(51,46,40,.2);border-radius:11px;font-size:14px;color:#2a241d;background:#fff;outline:none;}",
    "#quizBody .qz-in:focus{border-color:var(--accent,#b5552f);}",
    "#quizBody .qz-res{margin-top:10px;font-size:13px;line-height:1.6;padding:9px 11px;border-radius:9px;}",
    "#quizBody .qz-res:empty{display:none;padding:0;}",
    "#quizBody .qz-res.ok{color:#27734a;background:rgba(47,143,78,.1);}",
    "#quizBody .qz-res.no{color:#b23a32;background:rgba(192,70,62,.09);}",
    "#quizBody .qz-res .qz-explain{margin-top:5px;color:#6b6258;font-weight:500;}",
    "#quizActions .qz-submit{padding:11px 20px;border:0;border-radius:11px;background:var(--accent,#b5552f);color:#fff;font-weight:800;font-size:13.5px;cursor:pointer;}",
    "#quizActions .qz-submit:disabled{opacity:.62;cursor:wait;}",
    "#quizActions .qz-scoretxt{font-weight:900;font-size:14px;color:#2a241d;}",
    "#quizActions .qz-ghost{padding:11px 14px;border:1.5px solid rgba(51,46,40,.2);border-radius:11px;background:none;color:#6b6258;font-weight:700;font-size:13px;cursor:pointer;}",
    "#quizActions .qz-ghost:hover{border-color:var(--accent,#b5552f);color:var(--accent,#b5552f);}",
    "#quizBody .qz-setup{display:flex;flex-direction:column;gap:16px;}",
    "#quizBody .qz-field{display:flex;flex-direction:column;gap:8px;}",
    "#quizBody .qz-flabel{font-weight:800;font-size:12.5px;color:#6b6258;}",
    "#quizBody .qz-seg{display:flex;gap:7px;flex-wrap:wrap;}",
    "#quizBody .qz-seg button{min-width:46px;padding:9px 13px;border:1.5px solid rgba(51,46,40,.16);border-radius:10px;background:#fff;color:#2a241d;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;}",
    "#quizBody .qz-seg button:hover{border-color:rgba(181,85,47,.5);}",
    "#quizBody .qz-seg button.sel{background:var(--accent,#b5552f);color:#fff;border-color:var(--accent,#b5552f);}",
    "#quizBody .qz-types{display:flex;gap:8px;flex-wrap:wrap;}",
    "#quizBody .qz-type{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;border:1.5px solid rgba(51,46,40,.16);border-radius:10px;background:#fff;font-size:13.5px;font-weight:700;color:#2a241d;cursor:pointer;}",
    "#quizBody .qz-type:has(input:checked){border-color:var(--accent,#b5552f);background:rgba(181,85,47,.1);}",
    "#quizBody .qz-type input{accent-color:var(--accent,#b5552f);width:16px;height:16px;margin:0;}",
    "#quizBody .qz-head{margin-bottom:14px;display:flex;flex-direction:column;gap:5px;}",
    "#quizBody .qz-mode{align-self:flex-start;font-size:11.5px;font-weight:800;border-radius:999px;padding:3px 11px;}",
    "#quizBody .qz-mode.ok{color:#27734a;background:rgba(47,143,78,.12);}",
    "#quizBody .qz-mode.warn{color:#9a6a1e;background:rgba(196,140,40,.16);}",
    "#quizBody .qz-meta{font-size:12px;color:#6b6258;}",
    "#quizBody .qz-q.r-ok{border-color:rgba(47,143,78,.55);}",
    "#quizBody .qz-q.r-no{border-color:rgba(192,70,62,.55);}",
    "#quizBody .qz-check{margin-top:11px;padding:7px 15px;border:1.5px solid var(--accent,#b5552f);border-radius:9px;background:none;color:var(--accent,#b5552f);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;}",
    "#quizBody .qz-check:hover{background:rgba(181,85,47,.08);}",
    "#quizBody .qz-check:disabled{opacity:.55;cursor:wait;}",
    "#quizBody .qz-evi{margin-top:16px;border-top:1px dashed rgba(51,46,40,.2);padding-top:12px;}",
    "#quizBody .qz-evi-toggle{border:0;background:none;color:#6b6258;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;padding:0;}",
    "#quizBody .qz-evi-toggle:hover{color:var(--accent,#b5552f);}",
    "#quizBody .qz-evi-list{margin-top:10px;display:flex;flex-direction:column;gap:9px;}",
    "#quizBody .qz-evi-list[hidden]{display:none;}",
    "#quizBody .qz-evi-card{border:1px solid rgba(51,46,40,.12);border-radius:10px;padding:10px 12px;background:#fff;}",
    "#quizBody .qz-evi-card .ec-meta{font-size:11px;color:#9a8f82;font-weight:700;margin-bottom:3px;}",
    "#quizBody .qz-evi-card h4{margin:0 0 3px;font-size:13px;color:#2a241d;}",
    "#quizBody .qz-evi-card .ec-text{font-size:12px;color:#6b6258;line-height:1.55;margin:0;}",
    "#quizBody .qz-evi-empty{font-size:12px;color:#9a8f82;margin-top:8px;line-height:1.5;}"
  ].join("");

  function ensureDom() {
    if ($("quizModal")) return;
    var holder = document.createElement("div"); holder.innerHTML = MODAL_HTML;
    while (holder.firstChild) document.body.appendChild(holder.firstChild);
    if (!$("quizStyle")) { var st = document.createElement("style"); st.id = "quizStyle"; st.textContent = STYLE; document.head.appendChild(st); }
    $("quizClose").onclick = function () { $("quizModal").style.display = "none"; };
    $("quizModal").addEventListener("click", function (e) { if (e.target === $("quizModal")) $("quizModal").style.display = "none"; });
  }

  var quizData = null, lastQuizTopic = "";
  var QZ_TYPE_LABEL = { multiple_choice: "객관식", true_false: "OX", short_answer: "단답형" };
  function qzOptLabel(q, c) {
    if (q.type === "true_false") { var t = String(c).trim().toUpperCase(); if (t === "O") return "⭕  맞다 (O)"; if (t === "X") return "❌  틀리다 (X)"; }
    return esc2(c);
  }

  function openQuiz() { ensureDom(); $("quizModal").style.display = "block"; renderQuizSetup(); }

  // 설정 화면 — 주제·문제 수·유형 선택(/quiz/json 의 topic/count/quiz_types). 주제는 자동완성 없이 빈 칸.
  function renderQuizSetup() {
    $("quizBody").innerHTML =
      '<div class="qz-setup">' +
      '<div class="qz-field"><span class="qz-flabel">주제</span>' +
      '<input id="qzTopic" class="qz-in" placeholder="주제 입력 (비우면 전체)" autocomplete="off"></div>' +
      '<div class="qz-field"><span class="qz-flabel">문제 수</span><div class="qz-seg" id="qzCount">' +
      [3, 5, 8, 10].map(function (n) { return '<button type="button" data-count="' + n + '"' + (n === 5 ? ' class="sel"' : '') + '>' + n + '</button>'; }).join("") +
      '</div></div>' +
      '<div class="qz-field"><span class="qz-flabel">문제 유형</span><div class="qz-types" id="qzTypes">' +
      Object.keys(QZ_TYPE_LABEL).map(function (k) { return '<label class="qz-type"><input type="checkbox" value="' + k + '" checked>' + QZ_TYPE_LABEL[k] + '</label>'; }).join("") +
      '</div></div>' +
      '</div>';
    $("quizBody").querySelectorAll("#qzCount button").forEach(function (b) {
      b.addEventListener("click", function () { $("quizBody").querySelectorAll("#qzCount button").forEach(function (x) { x.classList.toggle("sel", x === b); }); });
    });
    $("quizActions").innerHTML = '<button id="quizGenBtn" class="qz-submit">📝 퀴즈 만들기</button>';
    $("quizGenBtn").onclick = generateQuiz;
  }
  function quizBackBtn() { $("quizActions").innerHTML = '<button id="quizBackBtn" class="qz-ghost">← 설정으로</button>'; $("quizBackBtn").onclick = renderQuizSetup; }

  function generateQuiz() {
    var topic = ($("qzTopic") ? $("qzTopic").value : "").trim();
    var cBtn = $("quizBody").querySelector("#qzCount button.sel");
    var count = cBtn ? parseInt(cBtn.dataset.count, 10) : null;
    var types = [].map.call($("quizBody").querySelectorAll("#qzTypes input:checked"), function (el) { return el.value; });
    if (!types.length) { alert("문제 유형을 하나 이상 선택해 주세요."); return; }
    lastQuizTopic = topic;
    $("quizBody").innerHTML = '<div style="color:#7a7066">📝 퀴즈를 만드는 중…</div>'; $("quizActions").innerHTML = "";
    var body = { topic: topic, snapshot: snapshotKey(), quiz_types: types };
    if (count) body.count = count;
    fetch(ragBase() + "/quiz/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) { $("quizBody").innerHTML = '<div style="color:#b06a3a">퀴즈 기능이 아직 백엔드에 연결되지 않았어요 (' + r.status + '). graphrag에 /quiz/json 추가 후 작동합니다.</div>'; quizBackBtn(); return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j) return;
        quizData = j;
        if (!j.questions || !j.questions.length) { $("quizBody").innerHTML = '<div style="color:#b06a3a">만들 퀴즈가 없어요. 유형이나 주제를 바꿔보세요.</div>'; quizBackBtn(); return; }
        renderQuizQuestions(j.questions);
      })
      .catch(function () { $("quizBody").innerHTML = '<div style="color:#b03636">퀴즈 생성 실패 — 잠시 후 다시 시도하세요.</div>'; quizBackBtn(); });
  }

  function renderQuizQuestions(qs) {
    var j = quizData || {};
    var modeBadge = (j.mode === "llm_verified")
      ? '<span class="qz-mode ok">✓ LLM 검증 통과</span>'
      : '<span class="qz-mode warn">⚠ 대체(fallback) 모드' + (j.warning ? ": " + esc2(j.warning) : "") + '</span>';
    var header = '<div class="qz-head">' + modeBadge + '<div class="qz-meta">주제: ' + esc2(lastQuizTopic || "전체") + ' · ' + qs.length + '문항</div></div>';
    var cards = qs.map(function (q, i) {
      var type = q.type || (q.choices && q.choices.length ? "multiple_choice" : "short_answer");
      var badge = QZ_TYPE_LABEL[type] || "문제";
      var bodyHtml;
      if (type === "short_answer") {
        bodyHtml = '<input data-qi="' + i + '" class="qz-in" placeholder="정답 입력" autocomplete="off">';
      } else {
        var ch = (q.choices && q.choices.length) ? q.choices : (type === "true_false" ? ["O", "X"] : []);
        bodyHtml = '<div class="qz-opts">' + ch.map(function (c, ci) {
          return '<label class="qz-opt"><input type="radio" name="qz' + i + '" data-qi="' + i + '" value="' + ci + '"><span>' + qzOptLabel(q, c) + '</span></label>';
        }).join("") + '</div>';
      }
      return '<div class="qz-q" data-qi="' + i + '">' +
        '<div class="qz-qhead"><span class="qz-num">Q' + (i + 1) + '</span><span class="qz-badge">' + badge + '</span></div>' +
        '<div class="qz-question">' + esc2(q.question || "") + '</div>' +
        bodyHtml +
        '<button type="button" class="qz-check" data-qi="' + i + '">채점</button>' +
        '<div class="qz-res" data-qi="' + i + '"></div></div>';
    }).join("");
    $("quizBody").innerHTML = header + cards + renderEvidence();
    $("quizBody").querySelectorAll(".qz-check").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var qi = btn.dataset.qi, a = collectOne(qi);
        if (a == null) { btn.textContent = "답을 선택/입력해 주세요"; setTimeout(function () { btn.textContent = "채점"; }, 1200); return; }
        var ans = {}; ans[qi] = a; gradeAnswers(ans, [btn], false);
      });
    });
    var et = $("quizBody").querySelector(".qz-evi-toggle");
    if (et) et.onclick = function () { var l = $("quizBody").querySelector(".qz-evi-list"); if (l) l.hidden = !l.hidden; };
    $("quizActions").innerHTML = '<button id="quizSubmit" class="qz-submit">전체 채점</button><button id="quizResetBtn" class="qz-ghost">⚙ 다시 설정</button><span id="quizScore" class="qz-scoretxt"></span>';
    $("quizSubmit").onclick = function () { gradeAnswers(collectAnswers(), [$("quizSubmit")], true); };
    $("quizResetBtn").onclick = renderQuizSetup;
  }

  // 근거(Evidence) — 백엔드가 /quiz/json 응답에 evidence를 포함하면 자동 표시(현재 미포함 → 안내).
  function renderEvidence() {
    var ev = quizData && quizData.evidence;
    if (!ev || !ev.length) {
      return '<div class="qz-evi"><div class="qz-evi-empty">📎 근거 자료는 백엔드(/quiz/json)가 evidence를 제공하면 여기에 표시됩니다.</div></div>';
    }
    var cards = ev.map(function (it, i) { return '<div class="qz-evi-card"><div class="ec-meta">' + (i + 1) + ' · ' + esc2(it.source || "") + '</div><h4>' + esc2(it.title || "") + '</h4><p class="ec-text">' + esc2(it.text || "") + '</p></div>'; }).join("");
    return '<div class="qz-evi"><button type="button" class="qz-evi-toggle">📎 사용된 근거 ' + ev.length + '건 ▾</button><div class="qz-evi-list" hidden>' + cards + '</div></div>';
  }
  function collectOne(qi) {
    var inp = document.querySelector('#quizBody .qz-in[data-qi="' + qi + '"]');
    if (inp) return inp.value.trim() || null;
    var radio = document.querySelector('#quizBody input[type=radio][data-qi="' + qi + '"]:checked');
    return radio ? radio.value : null;
  }
  function collectAnswers() {
    var ans = {};
    document.querySelectorAll("#quizBody .qz-in").forEach(function (el) { if (el.value.trim()) ans[el.dataset.qi] = el.value.trim(); });
    document.querySelectorAll('#quizBody input[type=radio]:checked').forEach(function (el) { ans[el.dataset.qi] = el.value; });
    return ans;
  }
  function applyOneResult(res) {
    var card = document.querySelector('#quizBody .qz-q[data-qi="' + res.index + '"]');
    if (card) { card.classList.remove("r-ok", "r-no"); card.classList.add(res.correct ? "r-ok" : "r-no"); }
    var box = document.querySelector('#quizBody .qz-res[data-qi="' + res.index + '"]'); if (!box) return;
    box.className = "qz-res " + (res.correct ? "ok" : "no");
    box.innerHTML = "<b>" + (res.correct ? "✓ 정답" : "✗ 오답") + "</b>" +
      (res.answerText ? " · 정답: <b>" + esc2(res.answerText) + "</b>" : "") +
      (res.explanation ? '<div class="qz-explain">' + esc2(res.explanation) + "</div>" : "");
  }
  function updateQuizScore() {
    var graded = document.querySelectorAll("#quizBody .qz-q.r-ok, #quizBody .qz-q.r-no").length;
    var ok = document.querySelectorAll("#quizBody .qz-q.r-ok").length;
    var sc = $("quizScore"); if (sc) sc.textContent = graded ? "  " + ok + "/" + graded + " 정답" : "";
  }
  // 문제별/전체 채점 공통 — answers 부분집합 채점 가능. 점수는 채점된 카드로 누적.
  function gradeAnswers(answers, btns, isAll) {
    if (!quizData || !quizData.quiz_id) return;
    if (!Object.keys(answers).length) return;
    btns.forEach(function (b) { if (b) b.disabled = true; });
    var sub = isAll ? $("quizSubmit") : null; if (sub) sub.textContent = "채점 중…";
    fetch(ragBase() + "/quiz/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quiz_id: quizData.quiz_id, answers: answers }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        (j.results || []).forEach(applyOneResult);
        updateQuizScore();
        if (isAll) { if (sub) sub.textContent = "다시 채점"; saveQuizResult(j); }
      })
      .catch(function () { if (sub) sub.textContent = "채점 실패"; })
      .then(function () { btns.forEach(function (b) { if (b) b.disabled = false; }); });
  }
  // 채점 결과를 Mindpalace 백엔드(quiz_results)에 저장. 정답은 graphrag 만 알고, 여기엔 점수·오답 문항만.
  function saveQuizResult(graded) {
    try {
      if (!quizData || !quizData.quiz_id || !graded) return;
      var wrong = (graded.results || []).filter(function (r) { return !r.correct; }).map(function (r) {
        var q = quizData.questions && quizData.questions[r.index];
        return { question: (q && q.question) || "", answerText: r.answerText || "" };
      });
      fetch("/api/quiz/result", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizId: quizData.quiz_id, score: graded.score || 0, total: graded.total || 0, palaceId: palaceId(), topic: lastQuizTopic, wrong: wrong })
      }).catch(function () {});
    } catch (e) {}
  }

  window.mpOpenQuiz = openQuiz;
})();
