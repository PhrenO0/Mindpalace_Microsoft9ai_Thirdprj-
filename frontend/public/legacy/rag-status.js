/* 상단 RAG 진행바 — PDF 분석(GraphRAG)이 백그라운드로 도는 동안 모든 페이지에 진행 상태 팝업을 띄운다.
   localStorage 'mp_rag_job' = {jobId, base, filename, startedAt}. 업로드(home.html)에서 비블로킹으로 시작하고,
   이 스크립트가 어느 페이지에서든 이어받아 폴링한다. palace_ready 되면 mp_palace 저장 + 'mp-rag-ready' 이벤트 발행
   (구성·노드 화면 해금에 사용). 각 페이지에 <script src="rag-status.js" defer></script> 한 줄로 동작.
   진행바는 팝업(칩) 안 상단에 막대로 표시한다. */
(function () {
  try {
    var P = new URLSearchParams(location.search);
    if (P.get("dash") === "1" || window.self !== window.top) return; // 임베드(대시보드 iframe)·dash 모드엔 미주입

    var job = null;
    try { job = JSON.parse(localStorage.getItem("mp_rag_job") || "null"); } catch (_) {}
    if (!job || !job.jobId || !job.base) return; // 진행 중인 분석 없음
    if (job.done) { try { window.dispatchEvent(new CustomEvent("mp-rag-ready")); } catch (_) {} return; } // 이미 완료

    var STAGE = {
      QUEUED:        { pct: 35,  label: "대기 중" },
      PREPROCESSING: { pct: 52,  label: "텍스트·이미지 추출" },
      INDEXING:      { pct: 72,  label: "개념 그래프 인덱싱" },
      PALACE_READY:  { pct: 95,  label: "방 구성" },
      RAG_READY:     { pct: 98,  label: "마무리" },
      DONE:          { pct: 100, label: "완료" }
    };

    var css =
      "#mpRagChip{position:fixed;top:54px;right:14px;z-index:10001;width:min(400px,calc(100vw - 24px));" +
      "border-radius:14px;background:rgba(245,241,234,.97);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);" +
      "border:1px solid rgba(51,46,40,.14);box-shadow:0 12px 32px rgba(40,34,26,.20);overflow:hidden;" +
      "font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;color:#2a241d;}" +
      "#mpRagBar{position:absolute;top:0;left:0;height:5px;width:0;z-index:2;" +
      "background:linear-gradient(90deg,#b5552f,#c4623a);box-shadow:0 0 8px rgba(181,85,47,.5);" +
      "transition:width .6s ease;border-radius:0 4px 4px 0;}" +
      "#mpRagInner{display:flex;align-items:center;gap:12px;padding:16px 15px 15px;}" +
      "#mpRagChip .rg-ic{font-size:21px;flex:none;}" +
      "#mpRagChip .rg-ic.spin{animation:mpRagSpin 1.6s linear infinite;}" +
      "@keyframes mpRagSpin{to{transform:rotate(360deg);}}" +
      "#mpRagChip .rg-tx{font-weight:800;line-height:1.4;min-width:0;font-size:14px;flex:1;}" +
      "#mpRagChip .rg-tx small{display:block;color:rgba(42,36,29,.6);font-weight:500;font-size:12px;margin-top:2px;" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      "#mpRagChip .rg-go{flex:none;text-decoration:none;font-weight:800;font-size:12.5px;color:#fff;" +
      "background:linear-gradient(180deg,#b5552f,#c4623a);padding:8px 13px;border-radius:10px;white-space:nowrap;}" +
      "#mpRagChip .rg-go:hover{filter:brightness(1.07);}" +
      "#mpRagChip .rg-x{flex:none;background:none;border:none;color:rgba(42,36,29,.5);font-size:15px;cursor:pointer;padding:2px 3px;line-height:1;}" +
      "#mpRagChip .rg-x:hover{color:#2a241d;}" +
      "#mpRagChip.rg-done .rg-ic.spin{animation:none;}" +
      // 반짝이는 효과 — 처리 중 칩 테두리가 은은하게 빛났다 가라앉음(지루함 완화).
      "#mpRagChip{animation:mpRagGlow 2.6s ease-in-out infinite;}" +
      "#mpRagChip.rg-done{animation:none;}" +
      "@keyframes mpRagGlow{0%,100%{box-shadow:0 12px 32px rgba(40,34,26,.20);}50%{box-shadow:0 12px 32px rgba(40,34,26,.20),0 0 0 2px rgba(196,98,58,.35),0 0 18px rgba(196,98,58,.30);}}" +
      // 다음 행동 추천 팁(회전) — 페이드로 부드럽게 교체.
      "#mpRagTip{padding:0 15px 13px;margin-top:-6px;font-size:12.5px;color:#7a5a3a;font-weight:600;display:flex;align-items:center;gap:6px;}" +
      "#mpRagTip .tw{animation:mpTwinkle 1.4s ease-in-out infinite;}" +
      "@keyframes mpTwinkle{0%,100%{opacity:.4;transform:scale(.9);}50%{opacity:1;transform:scale(1.15);}}" +
      // 다음 행동(CTA) 반짝·둥실 — 어디를 누를지 한눈에.
      "#mpRagChip .rg-go{animation:mpRagCta 1.5s ease-in-out infinite;}" +
      "@keyframes mpRagCta{0%,100%{transform:translateY(0);box-shadow:0 0 0 0 rgba(196,98,58,0);}50%{transform:translateY(-3px);box-shadow:0 7px 16px rgba(196,98,58,.5),0 0 0 4px rgba(196,98,58,.20);}}" +
      "#mpRagChip.rg-done .rg-go{animation:none;}" +
      "#mpRagDismiss{margin-left:auto;font-size:11.5px;color:rgba(42,36,29,.42);font-weight:600;cursor:pointer;background:none;border:0;text-decoration:underline;padding:0;}" +
      "#mpRagDismiss:hover{color:#7a5a3a;}" +
      "#mpRagTipTx{transition:opacity .4s ease;}";
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    var fname = job.filename ? String(job.filename).replace(/[<>&"]/g, "") : "학습자료";
    var chip = document.createElement("div"); chip.id = "mpRagChip";
    var CITY = (P.get("city") || "").trim();
    var cityQ = CITY ? ("?city=" + encodeURIComponent(CITY)) : "";
    var file = (location.pathname.split("/").pop() || "").toLowerCase().replace(".html", "");
    // 페이지별 '다음 행동' — PDF 넣은 뒤 둘러보기 → 구성 → 입장까지 차례로 안내(반짝·둥실).
    var nextStep = (file === "region-select") ? { href: "#", label: "🔭 둘러보기", explore: true }
                 : (file === "compose")       ? { href: "vworld_map.html" + cityQ, label: "🚪 방 입장" }
                 :                              { href: "region-select.html" + cityQ, label: "🗺 둘러보기" };
    chip.innerHTML =
      '<div id="mpRagBar"></div>' +
      '<div id="mpRagInner">' +
        '<span class="rg-ic spin" id="mpRagIc">📚</span>' +
        '<div class="rg-tx"><span id="mpRagLabel">PDF 분석 중…</span><small>' + fname + "</small></div>" +
        '<a class="rg-go" id="mpRagGo" href="' + nextStep.href + '">' + nextStep.label + '</a>' +
        '<button class="rg-x" id="mpRagX" title="숨기기">✕</button>' +
      "</div>" +
      '<div id="mpRagTip"><span class="tw">✨</span><span id="mpRagTipTx">분석하는 동안 명소를 먼저 둘러보세요!</span>' +
        '<button id="mpRagDismiss" type="button">다시 보지 않기</button></div>';

    // 다음 행동 추천 멘트 — 처리 중 지루하지 않게 회전(반짝임과 함께).
    var TIPS = [
      "분석하는 동안 명소를 먼저 둘러보세요!",
      "선택한 도시의 랜드마크를 미리 구경해 보세요.",
      "방 디자인이 어떤 게 있는지 둘러볼 수 있어요.",
      "마음에 드는 방을 골라두면 분석 후 바로 입장!",
      "분석이 끝나면 학습 내용이 방 안에 채워집니다.",
      "랜드마크 마커는 끌어서 순서를 바꿀 수 있어요."
    ];
    var tipI = 0, tipTimer = null;
    function rotateTip() {
      var tx = document.getElementById("mpRagTipTx"); if (!tx) return;
      tx.style.opacity = "0";
      setTimeout(function () { tipI = (tipI + 1) % TIPS.length; tx.textContent = TIPS[tipI]; tx.style.opacity = "1"; }, 400);
    }

    function mount() {
      try { if (localStorage.getItem("mp_onboard_off") === "1") return; } catch (_) {}   // '다시 보지 않기' 누른 적 있으면 온보딩 미표시
      document.body.appendChild(chip);
      document.getElementById("mpRagX").onclick = function () { chip.style.display = "none"; if (tipTimer) clearInterval(tipTimer); };
      var dz = document.getElementById("mpRagDismiss");
      if (dz) dz.onclick = function () { try { localStorage.setItem("mp_onboard_off", "1"); } catch (_) {} chip.style.display = "none"; if (tipTimer) clearInterval(tipTimer); };
      if (nextStep.explore) {   // region-select: '둘러보기' = 페이지 이동 대신, 도시 카드를 반짝·들썩으로 가리켜 클릭 유도
        var goEl = document.getElementById("mpRagGo");
        if (goEl) goEl.onclick = function (e) { e.preventDefault();
          try { window.dispatchEvent(new CustomEvent("mp-onboard-explore")); } catch (_) {} };
      }
      tipTimer = setInterval(rotateTip, 4200);   // 4.2초마다 다음 추천 멘트
    }
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

    function setBar(pct) { var b = document.getElementById("mpRagBar"); if (b) b.style.width = Math.max(2, Math.min(100, pct)) + "%"; }
    function setLabel(t) { var el = document.getElementById("mpRagLabel"); if (el) el.textContent = t; }

    var stopped = false;
    function finish() {
      stopped = true;
      if (tipTimer) clearInterval(tipTimer);
      setBar(100); setLabel("분석 완료 · 방 미리보기로");
      chip.classList.add("rg-done");
      var ic = document.getElementById("mpRagIc"); if (ic) ic.textContent = "✅";
      var go = document.getElementById("mpRagGo"); if (go) { go.onclick = null; go.href = "compose.html" + (CITY ? ("?city=" + encodeURIComponent(CITY)) : ""); go.textContent = "방 미리보기 →"; }
      var tip = document.getElementById("mpRagTip"); if (tip) tip.innerHTML = '<span class="tw">🎉</span><span>학습 내용이 준비됐어요 — 방에 들어가 확인해 보세요!</span>';
      try { job.done = true; localStorage.setItem("mp_rag_job", JSON.stringify(job)); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent("mp-rag-ready")); } catch (_) {}
    }
    function fail(msg) {
      stopped = true;
      if (tipTimer) clearInterval(tipTimer);
      setLabel("분석 실패: " + (msg || "오류"));
      var b = document.getElementById("mpRagBar"); if (b) b.style.background = "#c0463e";
      var ic = document.getElementById("mpRagIc"); if (ic) { ic.textContent = "⚠️"; ic.classList.remove("spin"); }
    }
    // 잡 기록이 서버에서 사라짐(재시작 등으로 휘발성 var/ 가 날아감). 무한 폴링에 갇히지
    // 않게 멈추고, mp_rag_job 을 지워 다른 페이지에서 되살아나지 않게 한다(재업로드 안내).
    function lost() {
      stopped = true;
      if (tipTimer) clearInterval(tipTimer);
      try { localStorage.removeItem("mp_rag_job"); } catch (_) {}
      setLabel("이전 분석 작업을 찾을 수 없어요");
      var b = document.getElementById("mpRagBar"); if (b) b.style.background = "#c0463e";
      var ic = document.getElementById("mpRagIc"); if (ic) { ic.textContent = "⚠️"; ic.classList.remove("spin"); }
      var go = document.getElementById("mpRagGo"); if (go) { go.href = "home.html#upload"; go.textContent = "다시 업로드 →"; }
      var tip = document.getElementById("mpRagTip"); if (tip) tip.innerHTML = '<span>서버가 재시작되며 작업이 초기화됐어요. 다시 업로드해 주세요.</span>';
    }

    var gone = 0;
    async function poll() {
      if (stopped) return;
      try {
        var r = await fetch(job.base + "/orchestrator/jobs/" + job.jobId + "/status");
        if (r.ok) {
          gone = 0;
          var s = await r.json();
          var stg = STAGE[s.state];
          if (stg) { setBar(stg.pct); setLabel("PDF 분석 중 · " + stg.label); }
          if (s.state === "FAILED") { fail(s.error); return; }
          if (s.palace_ready) {
            var pr = await fetch(job.base + "/orchestrator/jobs/" + job.jobId + "/palace");
            if (pr.ok) {
              var text = await pr.text();
              JSON.parse(text); // 형식 검증
              try { sessionStorage.setItem("mp_palace", text); localStorage.setItem("mp_palace", text); } catch (_) {}
              finish(); return;
            }
          }
        } else if (r.status === 404) {
          // 잡이 서버에서 사라짐 — 전이적 404 대비 몇 번 재시도 후 포기하고 정리.
          if (++gone >= 3) { lost(); return; }
        }
      } catch (_) {}
      setTimeout(poll, 3000);
    }
    setBar(20); setLabel("PDF 분석 중…"); setTimeout(poll, 1200);
  } catch (e) { /* 진행바 실패는 페이지 동작에 영향 주지 않음 */ }
})();
