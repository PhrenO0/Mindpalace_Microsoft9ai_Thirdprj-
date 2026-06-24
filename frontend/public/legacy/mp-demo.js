/* 데모 모드 표시등(스위치 OFF) — localStorage 'mp_demo'==="1" 이면 모든 페이지 좌하단에 고정 배지로
   'ON' 을 알리고 '끄기' 버튼을 준다. 데모(한국사 샘플)는 실제 학습자료(mp_palace:*)를 전혀 건드리지
   않는 별도 오버레이라, 끄면 원래 상태(자료 있으면 그 자료, 없으면 빈 상태)로 즉시 복귀(reload)한다.
   켜기(ON)는 region-select·compose 의 '데모 데이터로 체험하기' 가 담당(mp_demo_palace 캐시 + mp_demo=1).
   각 페이지에 <script src="mp-demo.js" defer></script> 한 줄로 동작. */
(function () {
  try {
    if (window.self !== window.top) return;   // 임베드(대시보드 iframe)엔 미표시
    function isOn() { try { return localStorage.getItem("mp_demo") === "1"; } catch (_) { return false; } }
    function hasCache() { try { return !!(localStorage.getItem("mp_demo_palace") || sessionStorage.getItem("mp_demo_palace")); } catch (_) { return false; } }
    // 자가복구: 데모 ON 인데 캐시가 사라진 경우(외부 eviction 등) — 페이지마다 폴백이 달라 불일치가
    //   생기지 않게 여기서 한 번에 처리. 번들로 캐시 복구 후 1회 새로고침(모든 페이지 일관). 복구·저장
    //   실패면 데모를 끄고 새로고침(빈 상태로 일관) → 무한 새로고침 없음.
    if (isOn() && !hasCache()) {
      fetch("public/data/korean_history.palace.json").then(function (r) { return r.json(); }).then(function (pal) {
        var ok = false;
        try { var s = JSON.stringify(pal); localStorage.setItem("mp_demo_palace", s); sessionStorage.setItem("mp_demo_palace", s); ok = !!localStorage.getItem("mp_demo_palace"); } catch (_) {}
        if (!ok) { try { localStorage.removeItem("mp_demo"); localStorage.removeItem("mp_demo_entered"); sessionStorage.removeItem("mp_demo"); sessionStorage.removeItem("mp_demo_entered"); } catch (_) {} }
        location.reload();
      }).catch(function () {
        try { localStorage.removeItem("mp_demo"); localStorage.removeItem("mp_demo_entered"); sessionStorage.removeItem("mp_demo"); sessionStorage.removeItem("mp_demo_entered"); } catch (_) {}
        location.reload();
      });
      return;   // 곧 새로고침 — 배지 마운트 보류
    }
    function mount() {
      if (!isOn() || document.getElementById("mpDemoBadge")) return;
      var css =
        "#mpDemoBadge{position:fixed;right:14px;bottom:14px;z-index:10002;display:flex;align-items:center;gap:9px;" +
        "padding:9px 12px 9px 13px;border-radius:13px;background:rgba(45,38,30,.93);color:#fff;" +
        "font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;font-weight:800;font-size:13px;" +
        "box-shadow:0 8px 24px rgba(40,34,26,.30);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
        "border:1px solid rgba(255,255,255,.14);animation:mpDemoGlow 2.6s ease-in-out infinite;}" +
        "@keyframes mpDemoGlow{0%,100%{box-shadow:0 8px 24px rgba(40,34,26,.30);}50%{box-shadow:0 8px 24px rgba(40,34,26,.30),0 0 0 3px rgba(196,98,58,.42);}}" +
        "#mpDemoBadge .mdb-dot{width:8px;height:8px;border-radius:50%;background:#c4623a;box-shadow:0 0 8px #c4623a;flex:none;}" +
        "#mpDemoBadge .mdb-off{margin-left:3px;border:0;border-radius:9px;background:#c4623a;color:#fff;font-weight:800;font-size:12px;padding:5px 11px;cursor:pointer;font-family:inherit;}" +
        "#mpDemoBadge .mdb-off:hover{filter:brightness(1.08);}";
      var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      var b = document.createElement("div"); b.id = "mpDemoBadge";
      b.innerHTML = '<span class="mdb-dot"></span><span>🎬 데모 모드</span><button class="mdb-off" type="button">끄기</button>';
      b.querySelector(".mdb-off").onclick = function () {
        try { localStorage.removeItem("mp_demo"); localStorage.removeItem("mp_demo_entered"); sessionStorage.removeItem("mp_demo"); sessionStorage.removeItem("mp_demo_entered"); } catch (_) {}
        location.reload();
      };
      document.body.appendChild(b);
      reposition();
    }
    // 배지는 우하단 기본. 우하단/전폭 하단을 점유하는 페이지별 위젯 위로 올려 겹침 방지:
    //   compose .footbar(전폭 하단바), memory-walk .mini(미니맵)·.fab(가젯 버튼). 좌하단 전용 위젯
    //   (vworld .left-panel/perf, memory-walk .hint)은 배지가 우측이라 무시한다. 높이 가변·비동기 표시라 실측.
    function reposition() {
      try {
        var b = document.getElementById("mpDemoBadge"); if (!b) return;
        var vh = window.innerHeight, vw = window.innerWidth, raised = 14;
        var nodes = document.querySelectorAll(".footbar, .mini, .fab");
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i], cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) continue;
          var r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.height > vh * 0.7) continue;   // 풀스크린 오버레이 제외
          // 화면 하단부 + 우측(또는 전폭) 영역과 겹치는 것만 — 좌측 전용 위젯은 무시.
          if (r.bottom > vh - 260 && r.right > vw - 240) raised = Math.max(raised, (vh - r.top) + 10);
        }
        b.style.bottom = raised + "px";
      } catch (_) {}
    }
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
    // 같은 페이지에서 데모를 켜면(region-select 등) 새로고침 없이도 배지가 바로 뜨게.
    window.addEventListener("mp-demo-changed", mount);
    window.addEventListener("resize", reposition);
    window.addEventListener("load", reposition);
    // 비동기로 나타나는 위젯(미니맵·가젯 버튼)까지 잡도록 초기 ~6초간 재배치 후 정지.
    var _rt = 0, _riv = setInterval(function () { reposition(); if (++_rt > 8) clearInterval(_riv); }, 700);
  } catch (e) { /* 배지 실패는 페이지 동작에 영향 주지 않음 */ }
})();
