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
      "background:linear-gradient(180deg,#b5552f,#c4623a);padding:8px 13px;border-radius:10px;display:none;}" +
      "#mpRagChip .rg-go:hover{filter:brightness(1.07);}" +
      "#mpRagChip .rg-x{flex:none;background:none;border:none;color:rgba(42,36,29,.5);font-size:15px;cursor:pointer;padding:2px 3px;line-height:1;}" +
      "#mpRagChip .rg-x:hover{color:#2a241d;}" +
      "#mpRagChip.rg-done .rg-ic.spin{animation:none;}" +
      "#mpRagChip.rg-done .rg-go{display:inline-block;}";
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    var fname = job.filename ? String(job.filename).replace(/[<>&"]/g, "") : "학습자료";
    var chip = document.createElement("div"); chip.id = "mpRagChip";
    chip.innerHTML =
      '<div id="mpRagBar"></div>' +
      '<div id="mpRagInner">' +
        '<span class="rg-ic spin" id="mpRagIc">📚</span>' +
        '<div class="rg-tx"><span id="mpRagLabel">PDF 분석 중…</span><small>' + fname + "</small></div>" +
        '<a class="rg-go" id="mpRagGo" href="compose.html">방 미리보기 →</a>' +
        '<button class="rg-x" id="mpRagX" title="숨기기">✕</button>' +
      "</div>";

    function mount() {
      document.body.appendChild(chip);
      document.getElementById("mpRagX").onclick = function () { chip.style.display = "none"; };
    }
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

    function setBar(pct) { var b = document.getElementById("mpRagBar"); if (b) b.style.width = Math.max(2, Math.min(100, pct)) + "%"; }
    function setLabel(t) { var el = document.getElementById("mpRagLabel"); if (el) el.textContent = t; }

    var stopped = false;
    function finish() {
      stopped = true;
      setBar(100); setLabel("분석 완료 · 방 미리보기로");
      chip.classList.add("rg-done");
      var ic = document.getElementById("mpRagIc"); if (ic) ic.textContent = "✅";
      try { job.done = true; localStorage.setItem("mp_rag_job", JSON.stringify(job)); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent("mp-rag-ready")); } catch (_) {}
    }
    function fail(msg) {
      stopped = true;
      setLabel("분석 실패: " + (msg || "오류"));
      var b = document.getElementById("mpRagBar"); if (b) b.style.background = "#c0463e";
      var ic = document.getElementById("mpRagIc"); if (ic) { ic.textContent = "⚠️"; ic.classList.remove("spin"); }
    }

    async function poll() {
      if (stopped) return;
      try {
        var r = await fetch(job.base + "/orchestrator/jobs/" + job.jobId + "/status");
        if (r.ok) {
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
        }
      } catch (_) {}
      setTimeout(poll, 3000);
    }
    setBar(20); setLabel("PDF 분석 중…"); setTimeout(poll, 1200);
  } catch (e) { /* 진행바 실패는 페이지 동작에 영향 주지 않음 */ }
})();
