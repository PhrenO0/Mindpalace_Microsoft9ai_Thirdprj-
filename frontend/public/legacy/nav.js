/* 통일 상단바 — 모든 주요 페이지에서 처음·둘러보기·구성·3D지도로 이동.
   각 페이지에 <script src="nav.js" defer></script> 한 줄만 추가하면 자동 주입된다.
   ?city 파라미터는 보존하고, 현재 페이지는 강조(.on)한다. home.html은 자체 내비가 있어 제외. */
(function () {
  try {
    const P = new URLSearchParams(location.search);
    if (P.get("dash") === "1" || window.self !== window.top) return; // 임베드(대시보드 iframe)·dash 모드에선 미주입
    const CITY = (P.get("city") || "").trim();
    const file = (location.pathname.split("/").pop() || "").toLowerCase().replace(".html", "");
    // 현재 페이지 → 활성 키(스튜디오·워크는 4개 메인에 없으므로 비활성)
    const CUR = { "region-select": "region", "compose": "compose", "vworld_map": "map",
                  "glb-customizer": "", "memory-walk": "" }[file];
    if (CUR === undefined) return; // 등록 안 된 페이지엔 주입 안 함

    const withCity = (href, key) =>
      (CITY && key !== "home") ? href + (href.indexOf("?") < 0 ? "?" : "&") + "city=" + encodeURIComponent(CITY) : href;

    const ITEMS = [
      { key: "home",    label: "처음",    icon: "🏠", href: "home.html" },
      { key: "region",  label: "둘러보기", icon: "🗺", href: "region-select.html" },
      { key: "compose", label: "구성",    icon: "🛍", href: "compose.html" },
      { key: "map",     label: "3D 지도",  icon: "🌐", href: "vworld_map.html" },
    ];

    const css = `
    .mpnav{position:fixed;top:0;left:0;right:0;height:46px;z-index:9000;display:flex;align-items:center;gap:7px;
      padding:0 14px;background:rgba(245,241,234,.93);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border-bottom:1px solid rgba(51,46,40,.12);box-shadow:0 2px 10px rgba(40,34,26,.08);
      font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;}
    .mpnav .mpb{font-weight:900;font-size:13px;color:#2a241d;margin-right:8px;letter-spacing:-.01em;white-space:nowrap;}
    .mpnav a{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border:1px solid rgba(51,46,40,.12);
      border-radius:9px;background:rgba(51,46,40,.045);color:#2a241d;text-decoration:none;font-size:12.5px;
      font-weight:700;cursor:pointer;transition:.15s;white-space:nowrap;}
    .mpnav a:hover{border-color:rgba(44,122,99,.45);background:rgba(44,122,99,.10);transform:translateY(-1px);}
    .mpnav a.on{background:#2c7a63;border-color:#2c7a63;color:#fff;cursor:default;}
    .mpnav a.on:hover{transform:none;}
    body.mpnav-pad{padding-top:46px !important;}
    .mpnav.mpnav-float{left:50%;right:auto;transform:translateX(-50%);top:8px;height:auto;width:auto;
      border-radius:13px;padding:6px 9px;gap:6px;box-shadow:0 6px 20px rgba(40,34,26,.18);}
    .mpnav.mpnav-float .mpb{display:none;}
    @media(max-width:560px){.mpnav .mpb{display:none;}.mpnav a{padding:6px 9px;font-size:11.5px;}.mpnav{gap:5px;padding:0 9px;}}
    `;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    const nav = document.createElement("nav");
    nav.className = "mpnav";
    nav.setAttribute("aria-label", "주요 메뉴");
    nav.innerHTML = `<span class="mpb">기억의 궁전</span>` + ITEMS.map((it) =>
      (it.key === CUR)
        ? `<a class="on" aria-current="page">${it.icon} ${it.label}</a>`
        : `<a href="${withCity(it.href, it.key)}" title="${it.label}로 이동">${it.icon} ${it.label}</a>`
    ).join("");
    document.body.insertBefore(nav, document.body.firstChild);

    // 문서형(region-select·compose·glb-customizer)은 풀바+body 패딩,
    // 3D 몰입형(vworld_map·memory-walk)은 코너 UI를 안 가리도록 가운데 떠있는 컴팩트 바.
    const DOC = ["region-select", "compose", "glb-customizer"];
    if (DOC.includes(file)) {
      document.body.classList.add("mpnav-pad");
    } else {
      nav.classList.add("mpnav-float");
    }
  } catch (e) { /* 내비 주입 실패는 페이지 동작에 영향 주지 않음 */ }
})();
