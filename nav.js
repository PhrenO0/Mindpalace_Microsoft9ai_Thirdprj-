/* 통일 상단바 — 모든 주요 페이지에서 처음·둘러보기·구성·3D지도로 이동.
   각 페이지에 <script src="nav.js" defer></script> 한 줄만 추가하면 자동 주입된다.
   ?city 파라미터는 보존하고, 현재 페이지는 강조(.on)한다. home.html은 자체 내비가 있어 제외. */
(function () {
  try {
    // 전 페이지 공통 줄바꿈: 한글이 단어(어절) 중간에 끊기지 않게(keep-all) + 긴 토큰만 강제 줄바꿈(break-word).
    //   제목은 줄 길이 균형(balance), 본문은 고아줄 방지(pretty). 반환문보다 먼저 주입해 임베드/모든 맥락에 적용.
    if (!document.getElementById("mp-textwrap-style")) {
      var _tw = document.createElement("style"); _tw.id = "mp-textwrap-style";
      _tw.textContent = "*{word-break:keep-all;overflow-wrap:break-word;}h1,h2,h3,h4{text-wrap:balance;}p,li{text-wrap:pretty;}";
      (document.head || document.documentElement).appendChild(_tw);
    }
    const P = new URLSearchParams(location.search);
    if (P.get("dash") === "1" || window.self !== window.top) return; // 임베드(대시보드 iframe)·dash 모드에선 미주입
    const CITY = (P.get("city") || "").trim();
    const file = (location.pathname.split("/").pop() || "").toLowerCase().replace(".html", "");
    // 상단 목차 = 3구획. 현재 페이지가 어느 구획인지(활성). home은 자체 네비가 있어 미주입.
    //   2.공간 둘러보기=region-select / 3.나만의 공간 만들기=구성·방디자인·3D지도·방안
    const CUR = { "region-select": "browse",
                  "compose": "create", "glb-customizer": "create", "vworld_map": "create", "memory-walk": "create",
                  "bounding-box-visual": "explain", "how-it-all-works": "explain", "how-markers-work": "explain",
                  "how-route-works": "explain", "system-architecture": "explain", "pipeline-overview": "explain" }[file];
    if (CUR === undefined) return; // 등록 안 된 페이지(home 포함)엔 주입 안 함

    const withCity = (href, key) =>
      (CITY && key !== "explain") ? href + (href.indexOf("?") < 0 ? "?" : "&") + "city=" + encodeURIComponent(CITY) : href;

    // home.html의 상단 네비와 동일한 번호 라벨로 통일(동일 서비스 느낌).
    const ITEMS = [
      { key: "home",    label: "🏠 처음",                href: "home.html" },
      { key: "explain", label: "1 · 전체 기술 설명",     href: "bounding-box-visual.html" },
      { key: "browse",  label: "2 · 공간 둘러보기",      href: "region-select.html" },
      { key: "create",  label: "3 · 나만의 공간 만들기", href: "compose.html" },
    ];

    // home.html 상단바와 동일한 어두운 테마(같은 서비스 느낌) — 콘텐츠 페이지엔 솔리드, 3D 몰입형엔 컴팩트.
    const css = `
    .mpnav{position:fixed;top:0;left:0;right:0;height:52px;z-index:9000;display:flex;align-items:center;
      padding:0 28px;background:rgba(38,34,29,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border-bottom:1px solid rgba(99,91,81,.25);box-shadow:0 2px 14px rgba(0,0,0,.18);
      font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;}
    .mpnav .mpb{font-weight:700;font-size:16px;color:#f5f0e8;letter-spacing:-.01em;white-space:nowrap;text-decoration:none;}
    .mpnav .mpright{margin-left:auto;display:flex;align-items:center;gap:24px;}
    .mpnav a.mpsec{font-size:12.5px;color:rgba(245,240,232,.72);text-decoration:none;font-weight:600;
      transition:color .2s;white-space:nowrap;cursor:pointer;}
    .mpnav a.mpsec:hover{color:#f5f0e8;}
    .mpnav a.mpsec.on{color:#fff;font-weight:800;}
    body.mpnav-pad{padding-top:52px !important;}
    .mpnav.mpnav-float{left:50%;right:auto;transform:translateX(-50%);top:8px;height:auto;width:auto;
      padding:7px 14px;border-radius:13px;box-shadow:0 6px 22px rgba(0,0,0,.3);}
    .mpnav.mpnav-float .mpb{display:none;}
    .mpnav.mpnav-float .mpright{margin-left:0;gap:16px;}
    .mpnav .mpauth{display:flex;align-items:center;gap:6px;}
    .mpnav .mpauth-login{background:#b5552f;color:#fff;padding:7px 15px;border-radius:8px;font-size:12.5px;
      font-weight:800;text-decoration:none;white-space:nowrap;}
    .mpnav .mpauth-login:hover{filter:brightness(1.08);}
    .mpnav .mpauth-acc{color:rgba(245,240,232,.85);text-decoration:none;font-size:12.5px;font-weight:700;
      max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .mpnav.mpnav-float .mpauth{display:none;}  /* 3D 몰입형 컴팩트 바엔 계정 숨김 */
    .mpnav .mpdd{position:relative;}
    .mpnav .mpdd-t{display:inline-flex;align-items:center;gap:4px;}
    .mpnav .mpcar{font-size:9px;opacity:.7;transition:transform .2s;}
    .mpnav .mpdd.open .mpcar{transform:rotate(180deg);}
    .mpnav .mpdd-menu{position:absolute;top:calc(100% + 12px);left:50%;transform:translateX(-50%) translateY(-6px);
      min-width:214px;background:rgba(38,34,29,.97);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(99,91,81,.3);border-radius:12px;box-shadow:0 14px 32px rgba(0,0,0,.36);padding:6px;
      opacity:0;visibility:hidden;transition:opacity .18s,transform .18s,visibility .18s;z-index:9001;}
    .mpnav .mpdd.open .mpdd-menu{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);}
    .mpnav .mpdd-menu a{display:block;padding:9px 12px;border-radius:8px;color:rgba(245,240,232,.82);
      font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;transition:background .15s,color .15s;}
    .mpnav .mpdd-menu a:hover{background:rgba(181,85,47,.24);color:#fff;}
    @media(max-width:560px){.mpnav{padding:0 14px;}.mpnav .mpright{gap:14px;}.mpnav a.mpsec{font-size:11.5px;}}
    `;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    const nav = document.createElement("nav");
    nav.className = "mpnav";
    nav.setAttribute("aria-label", "주요 메뉴");
    nav.innerHTML = `<a class="mpb" href="${withCity("home.html", "explain")}">기억의 궁전</a>`;
    // 우측 그룹: 번호 라벨 링크(home과 동일) + 계정. 몰입형 바엔 컴팩트.
    // '전체 기술 설명'은 누르면 두 갈래(글 / 3D)를 고르는 드롭다운.
    const right = document.createElement("div");
    right.className = "mpright";
    const TECH_SUB = [
      { label: "📖 전체 기술 한눈에 (글)", href: "how-it-all-works.html" },
      { label: "🧊 3D 워크스루 (체험)",    href: "bounding-box-visual.html" },
    ];
    right.innerHTML = ITEMS.map((it) => {
      if (it.key === "explain") {
        const on = (CUR === "explain") ? " on" : "";
        return `<div class="mpdd">`
          + `<a class="mpsec mpdd-t${on}" role="button" aria-haspopup="true" aria-expanded="false" tabindex="0">${it.label} <span class="mpcar">▾</span></a>`
          + `<div class="mpdd-menu" role="menu">`
          + TECH_SUB.map((s) => `<a role="menuitem" href="${s.href}">${s.label}</a>`).join("")
          + `</div></div>`;
      }
      return (it.key === CUR)
        ? `<a class="mpsec on" aria-current="page">${it.label}</a>`
        : `<a class="mpsec" href="${withCity(it.href, it.key)}" title="${it.label}로 이동">${it.label}</a>`;
    }).join("");
    // Easy Auth 계정 섹션(로그인 → Microsoft / 로그인됨 → 마이페이지). 몰입형 바엔 숨김(CSS).
    const auth = document.createElement("div");
    auth.className = "mpauth";
    const back = encodeURIComponent(location.pathname + location.search);
    auth.innerHTML = `<a class="mpauth-login" href="/.auth/login/aad?post_login_redirect_uri=${back}">로그인</a>`;
    right.appendChild(auth);
    nav.appendChild(right);
    fetch("/.auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const cp = !d ? null : (Array.isArray(d) ? d[0] : (d.clientPrincipal || d));
        if (!cp) return; // 비로그인 → 로그인 버튼 유지
        const claims = cp.user_claims || cp.claims || [];
        const nm = claims.find((c) => /(^|\/)(name|nickname|givenname)$/i.test(c.typ || c.type || ""));
        let name = (nm && (nm.val || nm.value)) || cp.userDetails || cp.user_id || "내 계정";
        if (name.length > 10) name = name.slice(0, 10) + "…";
        auth.innerHTML = `<a class="mpauth-acc" href="mypage.html" title="마이페이지">👤 ${name}</a>`;
      })
      .catch(() => {});

    document.body.insertBefore(nav, document.body.firstChild);

    // '기술 설명' 드롭다운 토글 — 클릭으로 열고, 바깥 클릭/Esc로 닫는다.
    const dd = nav.querySelector(".mpdd");
    if (dd) {
      const t = dd.querySelector(".mpdd-t");
      const setOpen = (o) => { dd.classList.toggle("open", o); t.setAttribute("aria-expanded", o ? "true" : "false"); };
      t.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!dd.classList.contains("open")); });
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!dd.classList.contains("open")); }
        else if (e.key === "Escape") setOpen(false);
      });
      document.addEventListener("click", (e) => { if (!dd.contains(e.target)) setOpen(false); });
    }

    // 문서형은 풀바+body 패딩. 지도(vworld_map)는 다른 페이지와 같은 솔리드 통일 바(브랜드+메뉴+계정)를
    //   오버레이로 두고, 위쪽 떠있는 카드(안내·대시도크)를 바 아래로 내려 겹침 방지. 그 외 몰입형(memory-walk)은 컴팩트 플로트.
    // region-select 기준으로 모든 페이지 솔리드 바 통일. 문서형은 풀바+body 패딩, 몰입형(지도·방·3D 워크스루)은 솔리드 오버레이+상단 UI 내림.
    const DOC = ["region-select", "compose", "glb-customizer", "how-it-all-works",
                 "how-markers-work", "how-route-works", "system-architecture", "pipeline-overview"];
    if (DOC.includes(file)) {
      document.body.classList.add("mpnav-pad");
    } else if (file === "vworld_map" || file === "memory-walk") {
      // 랜드마크(vworld_map)·방안(memory-walk)은 다크 솔리드 바 대신 컴팩트 플로트 — 몰입 화면을 가리지 않게(사용자 요청).
      nav.classList.add("mpnav-float");
    } else if (file === "bounding-box-visual") {
      /* 전체 기술 설명(3D 워크스루): 다른 페이지와 동일한 솔리드 배너를 캔버스 위 오버레이로.
         (pad 미적용 = 기본 솔리드 .mpnav. 헤더·근거패널이 top:60px라 겹치지 않음) */
    } else {
      document.body.classList.add("mpnav-pad");   // 기본도 솔리드+패딩으로 통일
    }
  } catch (e) { /* 내비 주입 실패는 페이지 동작에 영향 주지 않음 */ }
})();
