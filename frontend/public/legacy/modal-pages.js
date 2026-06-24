/* 하위 기술 문서를 '팝업(모달 iframe)'으로 열어 머무는 느낌을 준다.
   사용법: <a href="how-route-works.html" data-modal data-title="동선 설계">…</a> + <script src="modal-pages.js" defer></script>
   - iframe 안(중첩)에선 비활성. 모달 안 페이지의 nav.js는 self!==top이라 자동으로 안 뜬다. */
(function () {
  try {
    if (window.self !== window.top) return; // iframe 내부에선 모달 미동작(중첩 방지)
    if (document.getElementById("mpop-style")) return;

    var css = ""
      + ".mpop-bd{position:fixed;inset:0;z-index:9500;background:rgba(36,28,18,.55);"
      + "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;"
      + "justify-content:center;padding:24px;opacity:0;transition:opacity .22s;}"
      + ".mpop-bd.on{opacity:1;}"
      + ".mpop{width:min(1100px,96vw);height:min(88vh,940px);background:#fff;border-radius:18px;overflow:hidden;"
      + "box-shadow:0 30px 80px rgba(0,0,0,.42);display:flex;flex-direction:column;transform:translateY(10px) scale(.99);transition:transform .22s;}"
      + ".mpop-bd.on .mpop{transform:none;}"
      + ".mpop-h{flex:0 0 46px;display:flex;align-items:center;gap:9px;padding:0 12px 0 18px;background:#FBF5EC;border-bottom:1px solid #EADFCD;"
      + "font-family:'Pretendard','Malgun Gothic',system-ui,sans-serif;}"
      + ".mpop-h .t{font-weight:800;font-size:14px;color:#241C12;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}"
      + ".mpop-h a.open{font-size:12px;font-weight:700;color:#B25400;text-decoration:none;border:1px solid #EADFCD;border-radius:8px;padding:6px 10px;background:#fff;white-space:nowrap;}"
      + ".mpop-h a.open:hover{background:#F3EADB;}"
      + ".mpop-h button.x{cursor:pointer;background:#fff;border:1px solid #EADFCD;border-radius:9px;width:30px;height:30px;font-size:15px;color:#6B5E4D;line-height:1;}"
      + ".mpop-h button.x:hover{background:#F0E7D8;color:#241C12;}"
      + ".mpop iframe{flex:1;border:0;width:100%;background:#fff;}"
      + "body.mpop-lock{overflow:hidden;}";
    var st = document.createElement("style"); st.id = "mpop-style"; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);

    var current = null;
    function close() {
      if (!current) return;
      var bd = current; current = null;
      bd.classList.remove("on"); document.body.classList.remove("mpop-lock");
      document.removeEventListener("keydown", onKey);
      setTimeout(function () { if (bd && bd.parentNode) bd.parentNode.removeChild(bd); }, 230);
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    function open(href, title) {
      if (current) close();
      var bd = document.createElement("div"); bd.className = "mpop-bd"; bd.setAttribute("role", "dialog"); bd.setAttribute("aria-modal", "true");
      var pop = document.createElement("div"); pop.className = "mpop";
      var h = document.createElement("div"); h.className = "mpop-h";
      var t = document.createElement("span"); t.className = "t"; t.textContent = title || "";
      var openA = document.createElement("a"); openA.className = "open"; openA.href = href; openA.target = "_blank"; openA.rel = "noopener"; openA.textContent = "새 탭 ↗";
      var x = document.createElement("button"); x.className = "x"; x.setAttribute("aria-label", "닫기"); x.textContent = "✕";
      var ifr = document.createElement("iframe"); ifr.src = href; ifr.title = title || "문서"; ifr.setAttribute("loading", "lazy");
      h.appendChild(t); h.appendChild(openA); h.appendChild(x);
      pop.appendChild(h); pop.appendChild(ifr); bd.appendChild(pop);
      document.body.appendChild(bd); document.body.classList.add("mpop-lock");
      x.addEventListener("click", close);
      bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
      document.addEventListener("keydown", onKey);
      current = bd;
      requestAnimationFrame(function () { bd.classList.add("on"); });
    }

    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-modal]") : null;
      if (!a) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      e.preventDefault();
      open(href, a.getAttribute("data-title") || (a.textContent || "").trim());
    });
  } catch (e) { /* 모달 실패는 페이지 동작에 영향 주지 않음 */ }
})();
