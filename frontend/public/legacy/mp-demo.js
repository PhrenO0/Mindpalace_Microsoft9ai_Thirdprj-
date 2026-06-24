/* 데모 모드 표시등(스위치 OFF) — localStorage 'mp_demo'==="1" 이면 모든 페이지 좌하단에 고정 배지로
   'ON' 을 알리고 '끄기' 버튼을 준다. 데모(한국사 샘플)는 실제 학습자료(mp_palace:*)를 전혀 건드리지
   않는 별도 오버레이라, 끄면 원래 상태(자료 있으면 그 자료, 없으면 빈 상태)로 즉시 복귀(reload)한다.
   켜기(ON)는 region-select·compose 의 '데모 데이터로 체험하기' 가 담당(mp_demo_palace 캐시 + mp_demo=1).
   각 페이지에 <script src="mp-demo.js" defer></script> 한 줄로 동작. */
(function () {
  try {
    if (window.self !== window.top) return;   // 임베드(대시보드 iframe)엔 미표시
    function isOn() { try { return localStorage.getItem("mp_demo") === "1"; } catch (_) { return false; } }
    function mount() {
      if (!isOn() || document.getElementById("mpDemoBadge")) return;
      var css =
        "#mpDemoBadge{position:fixed;left:14px;bottom:14px;z-index:10002;display:flex;align-items:center;gap:9px;" +
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
        try { localStorage.removeItem("mp_demo"); sessionStorage.removeItem("mp_demo"); } catch (_) {}
        location.reload();
      };
      document.body.appendChild(b);
    }
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
    // 같은 페이지에서 데모를 켜면(region-select 등) 새로고침 없이도 배지가 바로 뜨게.
    window.addEventListener("mp-demo-changed", mount);
  } catch (e) { /* 배지 실패는 페이지 동작에 영향 주지 않음 */ }
})();
