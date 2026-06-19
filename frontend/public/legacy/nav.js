/* 통일 상단바 — 모든 주요 페이지에서 처음·둘러보기·구성·3D지도로 이동.
   각 페이지에 <script src="nav.js" defer></script> 한 줄만 추가하면 자동 주입된다.
   ?city 파라미터는 보존하고, 현재 페이지는 강조(.on)한다. home.html은 자체 내비가 있어 제외. */
(function () {
  try {
    const P = new URLSearchParams(location.search);
    if (P.get("dash") === "1" || window.self !== window.top) return; // 임베드(대시보드 iframe)·dash 모드에선 미주입
    const CITY = (P.get("city") || "").trim();
    const file = (location.pathname.split("/").pop() || "").toLowerCase().replace(".html", "");
    // 상단 목차 = 3구획. 현재 페이지가 어느 구획인지(활성). home은 자체 네비가 있어 미주입.
    //   2.공간 둘러보기=region-select / 3.나만의 공간 만들기=구성·방디자인·3D지도·방안
    const CUR = { "region-select": "browse",
                  "compose": "create", "glb-customizer": "create", "vworld_map": "create", "memory-walk": "create" }[file];
    if (CUR === undefined) return; // 등록 안 된 페이지(home 포함)엔 주입 안 함

    const withCity = (href, key) =>
      (CITY && key !== "explain") ? href + (href.indexOf("?") < 0 ? "?" : "&") + "city=" + encodeURIComponent(CITY) : href;

    const ITEMS = [
      { key: "explain", label: "기술 설명",         icon: "📖", href: "home.html" },
      { key: "browse",  label: "공간 둘러보기",      icon: "🗺", href: "region-select.html" },
      { key: "create",  label: "나만의 공간 만들기", icon: "🏗", href: "compose.html" },
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
    .mpnav a:hover{border-color:rgba(181, 85, 47,.45);background:rgba(181, 85, 47,.10);transform:translateY(-1px);}
    .mpnav a.on{background:#b5552f;border-color:#b5552f;color:#fff;cursor:default;}
    .mpnav a.on:hover{transform:none;}
    body.mpnav-pad{padding-top:46px !important;}
    .mpnav.mpnav-float{left:50%;right:auto;transform:translateX(-50%);top:8px;height:auto;width:auto;
      border-radius:13px;padding:6px 9px;gap:6px;box-shadow:0 6px 20px rgba(40,34,26,.18);}
    .mpnav.mpnav-float .mpb{display:none;}
    .mpnav .mpauth{margin-left:auto;display:flex;align-items:center;gap:6px;}
    .mpnav .mpauth-login{background:#b5552f;border-color:#b5552f;color:#fff;}
    .mpnav .mpauth-login:hover{filter:brightness(1.07);background:#b5552f;border-color:#b5552f;}
    .mpnav .mpauth-acc{max-width:160px;overflow:hidden;text-overflow:ellipsis;}
    .mpnav.mpnav-float .mpauth{display:none;}  /* 3D 몰입형 컴팩트 바엔 계정 숨김 */
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
    // 오른쪽: Easy Auth 계정 섹션(로그인 → 구글 / 로그인됨 → 마이페이지). 몰입형 바엔 숨김(CSS).
    const auth = document.createElement("div");
    auth.className = "mpauth";
    const back = encodeURIComponent(location.pathname + location.search);
    auth.innerHTML = `<a class="mpauth-login" href="/.auth/login/google?post_login_redirect_uri=${back}">로그인</a>`;
    nav.appendChild(auth);
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
