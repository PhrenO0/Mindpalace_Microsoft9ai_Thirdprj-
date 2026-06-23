/* 기억의 궁전 — 전역 도우미(룰 기반, LLM 없음)
   · 모든 페이지에 떠 있는 챗봇: 테마 설정 + 흐름 안내
   · 테마/글씨크기/가벼운모드는 localStorage로 전 페이지 지속
   사용: <script src="assistant.js" defer></script> 만 넣으면 됨 */
(function () {
  "use strict";
  var LS_THEME = "mp_theme", LS_ZOOM = "mp_zoom", LS_LITE = "mp_lite", LS_OPEN = "mp_asst_open";

  // ── 음성(시각 접근성): 토큰 엔드포인트 기본값 + TTS/STT 엔진 자동 주입(모든 페이지 공통) ──
  // 페이지에서 window.MP_TTS_TOKEN_URL 을 미리 지정했다면 그대로 둔다(예: home.html).
  if (!window.MP_TTS_TOKEN_URL) {
    window.MP_TTS_TOKEN_URL = "https://3d-mindpalace-ai-backend-h3gze8h7hfhqg3h8.canadacentral-01.azurewebsites.net/api/speech-token";
  }
  function loadVoiceScript(src, ready) {
    if (ready() || document.querySelector('script[src*="' + src + '"]')) return; // 이미 로드됨(중복 방지)
    var s = document.createElement("script"); s.src = src; s.defer = true; document.head.appendChild(s);
  }
  loadVoiceScript("tts-controls.js", function () { return !!window.mpTTS; }); // 답변 낭독 엔진
  loadVoiceScript("stt-controls.js", function () { return !!window.mpSTT; }); // 마이크 입력 애드온

  // ── 테마 프리셋(전 페이지 공통 토큰) ──
  var PRESETS = {
    sage:   { name:"묵향 세이지", dot:"#2c7a63",
      bg:"#f5f1ea", panel:"rgba(255,255,255,.86)", panel2:"#ffffff", "panel-strong":"#ffffff",
      line:"rgba(51,46,40,.12)", text:"#2a241d", ink:"#2a241d", muted:"rgba(42,36,29,.62)",
      accent:"#2c7a63", accent2:"#348a72", gold:"#8a8170", taupe:"#8a8170", shadow:"0 18px 50px rgba(40,34,26,.14)" },
    indigo: { name:"학예 인디고", dot:"#4f56d3",
      bg:"#f6f7fb", panel:"rgba(255,255,255,.88)", panel2:"#ffffff", "panel-strong":"#ffffff",
      line:"rgba(22,26,40,.12)", text:"#191c28", ink:"#191c28", muted:"rgba(25,28,40,.6)",
      accent:"#4f56d3", accent2:"#5a61de", gold:"#8b8fa0", taupe:"#8b8fa0", shadow:"0 18px 50px rgba(26,30,52,.14)" },
    clay:   { name:"박물관 클레이", dot:"#b5552f",
      bg:"#f7f3ec", panel:"rgba(255,255,255,.86)", panel2:"#ffffff", "panel-strong":"#ffffff",
      line:"rgba(33,27,22,.12)", text:"#221a14", ink:"#221a14", muted:"rgba(40,32,26,.6)",
      accent:"#b5552f", accent2:"#c4623a", gold:"#98917f", taupe:"#98917f", shadow:"0 18px 50px rgba(54,40,30,.14)" }
  };
  var SKIP_VAR = { name:1, dot:1 };

  function get(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }

  function applyVars(name){
    var p = PRESETS[name] || PRESETS.sage;
    var s = document.getElementById("mp-theme-vars");
    if (!s){ s = document.createElement("style"); s.id = "mp-theme-vars"; (document.head || document.documentElement).appendChild(s); }
    var css = ":root{"; for (var k in p){ if (!SKIP_VAR[k]) css += "--" + k + ":" + p[k] + ";"; } css += "}";
    s.textContent = css;
  }
  // 글씨 크기(#3): 화면 전체에 zoom을 걸되(가로 오버플로 방지), 챗봇 위젯은 역배율로 원래 크기 유지
  //   → 챗봇이 함께 커지지 않고 본문만 커지는 효과. (본문 래퍼에 직접 zoom 시 풀폭 레이아웃이 가로로 넘쳐 이 방식 채택)
  //   ※ 컨테이너만 역배율(자식은 상속) — 중복 적용 시 이중 축소되므로 위젯 루트만 지정.
  var ZOOM_FIXED_SEL = "#mp-asst, .phone-fab, .phone-chat";
  function applyZoom(z){
    document.documentElement.style.zoom = z || "";
    var inv = z ? String(1 / parseFloat(z)) : "";
    try { document.querySelectorAll(ZOOM_FIXED_SEL).forEach(function (el) { el.style.zoom = inv; }); } catch (e) {}
  }
  function applyLite(on){
    var s = document.getElementById("mp-lite-style");
    if (on && !s){ s = document.createElement("style"); s.id = "mp-lite-style";
      s.textContent = "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}*{box-shadow:none!important;}*{animation:none!important;transition:none!important;}";
      (document.head || document.documentElement).appendChild(s);
    } else if (!on && s){ s.remove(); }
  }
  // 즉시 적용(플래시 최소화) — 기본 테마=박물관 클레이
  applyVars(get(LS_THEME, "clay"));
  applyZoom(get(LS_ZOOM, ""));
  applyLite(get(LS_LITE, "0") === "1");

  // ── 외부(home.html 스마트폰 등)에서 테마를 제어할 수 있는 공개 API ──
  //   위젯(도우미)을 숨겨도 테마 엔진은 살아 있으므로, 스마트폰의 테마 칩이 이걸 호출한다.
  window.mpTheme = {
    set:  function (n) { if (!PRESETS[n]) return; set(LS_THEME, n); applyVars(n); },
    zoom: function (z) { set(LS_ZOOM, z); applyZoom(z); },
    toggleLite: function () { var on = get(LS_LITE, "0") !== "1"; set(LS_LITE, on ? "1" : "0"); applyLite(on); return on; },
    current: function () { return get(LS_THEME, "clay"); },
    isLite: function () { return get(LS_LITE, "0") === "1"; },
    presets: PRESETS
  };

  // ── 위젯 ──
  function build(){
    if (document.getElementById("mp-asst")) return;
    var STYLE = [
    ".mp-launch{position:fixed;right:18px;bottom:18px;z-index:99998;display:inline-flex;align-items:center;gap:8px;",
      "padding:11px 15px 11px 12px;border-radius:999px;border:1px solid var(--line,rgba(51,46,40,.12));cursor:pointer;",
      "background:var(--panel2,#fff);color:var(--text,#2a241d);box-shadow:0 12px 30px rgba(40,34,26,.22);font:inherit;font-weight:800;font-size:13px;}",
    ".mp-launch:hover{transform:translateY(-2px);} .mp-launch .d{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;",
      "background:var(--accent,#b5552f);color:#fff;font-size:13px;}",
    ".mp-panel{position:fixed;right:18px;bottom:74px;z-index:99999;width:min(340px,calc(100vw - 28px));max-height:min(560px,calc(100dvh - 224px));",
      "display:none;flex-direction:column;border:1px solid var(--line,rgba(51,46,40,.12));border-radius:18px;overflow:hidden;",
      "background:var(--bg,#f5f1ea);box-shadow:0 24px 60px rgba(40,34,26,.3);}",
    ".mp-panel.open{display:flex;}",
    ".mp-hd{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line);background:var(--panel2,#fff);}",
    ".mp-hd .d{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent,#b5552f);color:#fff;font-size:14px;}",
    ".mp-hd .t{font-weight:900;font-size:14px;color:var(--text);} .mp-hd .s{font-size:11px;color:var(--accent);font-weight:700;}",
    ".mp-hd .x{margin-left:auto;cursor:pointer;border:0;background:transparent;color:var(--muted);font-size:18px;line-height:1;}",
    ".mp-body{flex:1;overflow:auto;padding:13px;display:flex;flex-direction:column;gap:9px;}",
    ".mp-msg{max-width:86%;padding:9px 12px;border-radius:13px;font-size:13px;line-height:1.5;}",
    ".mp-msg.bot{align-self:flex-start;background:var(--panel2,#fff);border:1px solid var(--line);color:var(--text);border-bottom-left-radius:5px;}",
    ".mp-msg.me{align-self:flex-end;background:var(--accent,#b5552f);color:#fff;border-bottom-right-radius:5px;}",
    ".mp-chips{display:flex;flex-wrap:wrap;gap:6px;padding:7px 0 3px;}",
    ".mp-chip{cursor:pointer;border:1px solid var(--line);background:var(--panel2,#fff);color:var(--text);border-radius:999px;",
      "padding:6px 11px;font:inherit;font-size:12px;font-weight:700;}",
    ".mp-chip:hover{border-color:var(--accent);background:rgba(181, 85, 47,.10);}",
    ".mp-foot{display:flex;gap:7px;padding:11px 13px;border-top:1px solid var(--line);background:var(--panel2,#fff);}",
    ".mp-foot input{flex:1;border:1px solid var(--line);border-radius:999px;padding:8px 13px;font:inherit;font-size:13px;background:var(--bg,#f5f1ea);color:var(--text);outline:none;}",
    ".mp-foot button{border:0;border-radius:50%;width:36px;height:36px;cursor:pointer;background:var(--accent,#b5552f);color:#fff;font-size:15px;}",
    ".mp-tools{border-top:1px solid var(--line);background:var(--bg,#f5f1ea);}",
    ".mp-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:7px 13px;}",
    ".mp-tchip{cursor:pointer;border:1px solid var(--line);background:var(--panel2,#fff);color:var(--text);border-radius:999px;padding:5px 10px;font:inherit;font-size:11px;font-weight:700;line-height:1.2;}",
    ".mp-tchip:hover{border-color:var(--accent);}",
    ".mp-tchip[aria-expanded=true]{background:var(--accent,#b5552f);color:#fff;border-color:var(--accent);}",
    ".mp-topts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 13px 9px;}",
    ".mp-topts[hidden]{display:none;}",
    ".mp-topts .barrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;}",
    ".mp-topts .vseg{display:inline-flex;gap:4px;}",
    ".mp-topts button{cursor:pointer;border:1px solid var(--line);background:var(--panel2,#fff);color:var(--text);border-radius:999px;padding:5px 10px;font:inherit;font-size:11px;font-weight:700;line-height:1.2;}",
    ".mp-topts button:hover{border-color:var(--accent);}",
    ".mp-topts button.is-active,.mp-topts .vmaster[aria-pressed=true]{background:var(--accent,#b5552f);color:#fff;border-color:var(--accent);}"
    ].join("");
    var st = document.createElement("style"); st.id = "mp-asst-style"; st.textContent = STYLE; document.head.appendChild(st);

    var wrap = document.createElement("div"); wrap.id = "mp-asst";
    wrap.innerHTML =
      '<button class="mp-launch" id="mpLaunch" title="기억의 궁전 도우미"><span class="d">宮</span>도우미</button>' +
      '<section class="mp-panel" id="mpPanel" role="dialog" aria-label="기억의 궁전 도우미">' +
        '<div class="mp-hd"><span class="d">宮</span><div><div class="t">기억의 궁전 도우미</div><div class="s">● 온라인 · 테마 도우미</div></div><button class="x" id="mpClose" aria-label="닫기">×</button></div>' +
        '<div class="mp-body" id="mpBody"></div>' +
        '<div class="mp-tools">' +
          '<div class="mp-toolbar">' +
            '<button type="button" class="mp-tchip" id="mpThemeToggle" aria-expanded="false" aria-controls="mpThemeOpts" aria-label="테마·글씨 메뉴">🎨 테마·글씨</button>' +
            '<button type="button" class="mp-tchip" id="mpNavToggle" aria-expanded="false" aria-controls="mpNavOpts" aria-label="화면 이동 메뉴">🧭 화면 이동</button>' +
            '<button type="button" class="mp-tchip" id="mpVoiceToggle" aria-expanded="false" aria-controls="mpVoiceOpts" aria-label="음성 안내 메뉴">🔈 음성 안내</button>' +
          '</div>' +
          '<div class="mp-topts" id="mpThemeOpts" hidden>' +
            '<div class="barrow">' +
              '<button type="button" data-theme="sage">세이지</button>' +
              '<button type="button" data-theme="indigo">인디고</button>' +
              '<button type="button" data-theme="clay">클레이</button>' +
            '</div>' +
            '<div class="barrow">' +
              '<button type="button" data-zoom="1.12">글씨 크게</button>' +
              '<button type="button" data-zoom="">기본</button>' +
              '<button type="button" data-zoom="0.92">글씨 작게</button>' +
            '</div>' +
          '</div>' +
          '<div class="mp-topts" id="mpNavOpts" hidden></div>' +
          '<div class="mp-topts" id="mpVoiceOpts" hidden>' +
            '<button type="button" class="vmaster" id="mpVoiceMaster" aria-pressed="false" aria-label="음성 안내 켜기">음성 안내 켜기</button>' +
            '<button type="button" id="mpVoiceGender" aria-label="목소리 전환 (현재 여성)">목소리: 여성</button>' +
            '<span class="vseg" role="group" aria-label="읽기 속도">' +
              '<button type="button" data-tts-speed="slow" aria-label="느리게 읽기">느리게</button>' +
              '<button type="button" data-tts-speed="normal" class="is-active" aria-label="보통 속도로 읽기">보통</button>' +
              '<button type="button" data-tts-speed="fast" aria-label="빠르게 읽기">빠르게</button>' +
            '</span>' +
            '<button type="button" id="mpVoiceSpatial" aria-pressed="false" aria-label="공간음향 켜기">공간음향: 끄기</button>' +
          '</div>' +
        '</div>' +
        '<div class="mp-foot"><input id="mpInput" placeholder="테마를 바꾸거나 질문하세요" /><button id="mpSend" aria-label="보내기">➤</button></div>' +
      '</section>';
    document.body.appendChild(wrap);
    applyZoom(get(LS_ZOOM, ""));   // 방금 만든 챗봇 위젯에 글씨크기 역배율 반영(저장된 값으로 로드된 경우)

    var panel = document.getElementById("mpPanel"), body = document.getElementById("mpBody"), input = document.getElementById("mpInput");
    function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]; }); }
    function addMsg(text, who){ var d = document.createElement("div"); d.className = "mp-msg " + (who || "bot"); d.innerHTML = esc(text); body.appendChild(d); body.scrollTop = body.scrollHeight;
      if ((who || "bot") === "bot" && window.__mpVoiceOn && window.mpTTS) { try { window.mpTTS.speak(text); } catch (e) {} } // 음성 안내 ON이면 봇 답변 낭독
      return d; }
    function addChips(chips){ if (!chips || !chips.length) return; var w = document.createElement("div"); w.className = "mp-chips";
      chips.forEach(function (c){ var b = document.createElement("button"); b.className = "mp-chip"; b.textContent = c.label; b.onclick = function(){ if (c.say) addMsg(c.label, "me"); act(c); }; w.appendChild(b); });
      body.appendChild(w); body.scrollTop = body.scrollHeight; }

    function setTheme(n){ set(LS_THEME, n); applyVars(n); addMsg("테마를 '" + PRESETS[n].name + "'(으)로 바꿨어요.", "bot"); markThemeActive(); }
    function markThemeActive(){ var opts = document.getElementById("mpThemeOpts"); if (!opts) return;
      var curT = get(LS_THEME, "sage"), curZ = get(LS_ZOOM, "");
      [].forEach.call(opts.querySelectorAll("[data-theme]"), function(b){ b.classList.toggle("is-active", b.getAttribute("data-theme") === curT); });
      [].forEach.call(opts.querySelectorAll("[data-zoom]"), function(b){ b.classList.toggle("is-active", b.getAttribute("data-zoom") === curZ); }); }
    function setZoom(z){ set(LS_ZOOM, z); applyZoom(z); addMsg(z ? ("화면 크기를 " + Math.round(parseFloat(z) * 100) + "%로 맞췄어요.") : "화면 크기를 기본으로 되돌렸어요.", "bot"); markThemeActive(); }
    function setLite(on){ set(LS_LITE, on ? "1" : "0"); applyLite(on); addMsg(on ? "가벼운 모드를 켰어요(그림자·효과 최소화)." : "가벼운 모드를 껐어요.", "bot"); }

    function themeChips(){ addChips([
      { label:"세이지", act:"theme", v:"sage", say:1 }, { label:"인디고", act:"theme", v:"indigo", say:1 }, { label:"클레이", act:"theme", v:"clay", say:1 },
      { label:"글씨 크게", act:"zoom", v:"1.12", say:1 }, { label:"글씨 작게", act:"zoom", v:"0.92", say:1 }
    ]); }
    function navChips(){ var c = [
      { label:"구성 화면", act:"go", v:"compose.html", say:1 },
      { label:"방 디자인 스튜디오", act:"go", v:"glb-customizer.html", say:1 },
      { label:"3D 지도", act:"go", v:"vworld_map.html", say:1 },
      { label:"처음으로", act:"go", v:"region-select.html", say:1 }
    ]; addChips(c); }
    // 추천 학습 항목 칩 — 방(memory-walk)이 노출한 미배치(demoted) 우선 추천. 누르면 빈 지점에 연결.
    function recoChips(){
      if (typeof window.mpRecommendations !== "function"){ addMsg("방 안(memory-walk)에서 추천·연결을 도와드릴 수 있어요.", "bot"); return; }
      var recs = window.mpRecommendations(10);
      if (recs && recs.length){
        addChips(recs.map(function(r){ return { label:(r.demoted?"🎯 ":"")+r.title+(r.type?(" · "+String(r.type).split(",")[0].trim()):""), act:"reco", v:r.id, say:1 }; }));
      } else { addMsg("학습 항목이 모두 배치됐어요 🎉 방에서 ➕ 지점을 추가하면 더 연결할 수 있어요.", "bot"); }
    }

    function act(c){
      if (c.act === "theme") return setTheme(c.v);
      if (c.act === "zoom") return setZoom(c.v);
      if (c.act === "lite") return setLite(get(LS_LITE, "0") !== "1");
      if (c.act === "go"){ var url = c.v; if (/compose|glb-customizer|vworld_map/.test(url) && CITY) url += (url.indexOf("?") < 0 ? "?" : "&") + "city=" + encodeURIComponent(CITY); location.href = url; return; }
      if (c.act === "enterFirst"){ var b = document.getElementById("startBtn") || document.querySelector(".enter,.go,.start"); if (b && b.href) location.href = b.href; else addMsg("이 화면엔 입장할 방이 없어요. '구성 화면'에서 학습을 먼저 구성해 주세요.", "bot"); return; }
      if (c.act === "hotspot"){   // 핫스팟 클릭 → 사물과 학습 개념 사이 '어거지' 의미 생성
        var r = (typeof window.mpForceMeaning === "function") ? window.mpForceMeaning(c.v) : null;
        if (r && r.concept){
          addMsg("🔗 " + r.object + "  ↔  '" + r.concept + "'   ·   좌표(" + (r.pos || []).join(", ") + ")", "bot");
          addMsg((r.bound ? "" : "(임시 연결) ") + (r.mnemonic || ""), "bot");
          if (r.desc) addMsg("📖 " + r.concept + ": " + r.desc, "bot");
        } else if (r){ addMsg(r.object + " — 아직 연결된 학습 개념이 없어요. 방에서 ➕ 지점으로 정의하면 연결됩니다.", "bot"); }
        else { addMsg("방 안(memory-walk)에서 이용해 주세요.", "bot"); }
        return;
      }
      if (c.act === "reco"){   // 추천 학습항목 칩 → 미배치 지점(없으면 첫 지점)에 개념 연결
        var rr = (typeof window.mpAssignConcept === "function") ? window.mpAssignConcept("auto", c.v) : null;
        if (rr && rr.ok){
          addMsg("🔗 " + rr.n + "번 " + rr.object + "  ↔  '" + rr.concept + "' 연결했어요.", "bot");
          if (rr.mnemonic) addMsg(rr.mnemonic, "bot");
          if (rr.desc) addMsg("📖 " + rr.concept + ": " + rr.desc, "bot");
          addMsg("계속 연결할까요?", "bot"); recoChips();   // 남은 추천 갱신
        } else { addMsg((rr && rr.reason) || "방 안(memory-walk)에서 이용해 주세요.", "bot"); }
        return;
      }
      if (c.act === "assign"){   // {n,id} → 특정 번호 지점에 개념 연결
        var v = c.v || {}, ra = (typeof window.mpAssignConcept === "function") ? window.mpAssignConcept(v.n, v.id) : null;
        if (ra && ra.ok){ addMsg("🔗 " + ra.n + "번 " + ra.object + "  ↔  '" + ra.concept + "' 연결.", "bot"); if (ra.mnemonic) addMsg(ra.mnemonic, "bot"); }
        else { addMsg((ra && ra.reason) || "연결하지 못했어요.", "bot"); }
        return;
      }
      if (c.act === "gotoHotspot"){ if (typeof window.mpGoToHotspot === "function") window.mpGoToHotspot(c.v); return; }   // 관련 개념 칩 → 그 학습 마커로 이동
      if (c.act === "mnemonic"){   // ✨ 의미 매치 — 우상단 카드의 의미부여와 동일(graphrag /mnemonic 모달)
        if (typeof window.mpOpenMnemonic === "function") { window.mpOpenMnemonic(); addMsg("✨ 사물에 학습 개념을 연결해 기억 장면을 만들어 드릴게요. (창에서 개념을 고르고 '생성')", "bot"); }
        else addMsg("방 안(memory-walk)에서 이용할 수 있어요.", "bot");
        return;
      }
      if (c.act === "quiz"){   // 📝 퀴즈 — 학습내용으로 퀴즈 생성·채점(주제·문제수·유형 선택)
        if (typeof window.mpOpenQuiz === "function") { window.mpOpenQuiz(); addMsg("📝 학습 내용으로 퀴즈를 만들어 드릴게요. 주제·문제 수·유형을 고르고 '퀴즈 만들기'를 눌러 보세요.", "bot"); }
        else addMsg("퀴즈를 준비 중이에요. 잠시 후 다시 시도해 주세요.", "bot");
        return;
      }
      if (c.act === "intent") return ruleReply(c.v);
    }

    // ── OpenAI 연결 지점 ──
    //   추후 실제 OpenAI 연결: window.mpAssistantAsk(text, ctx) 를 정의(async, {text, chips?} 반환)하면 우선 사용.
    //   보안상 백엔드 프록시(예: POST /api/chat)로 호출 권장(키 노출 금지). 테마·이동 칩은 LLM과 무관하게 항상 동작하는 '도구'로 유지.
    async function getReply(text){
      if (typeof window.mpAssistantAsk === "function"){
        var t = addMsg("…", "bot");
        try {
          var r = await window.mpAssistantAsk(text, { page: typeof pg !== "undefined" ? pg : "", city: CITY });
          if (r && (r.text || r.reply)){ t.innerHTML = esc(r.text || r.reply); if (r.chips) addChips(r.chips); return; }
        } catch (e) {}
        t.remove();
      }
      ruleReply(text);   // 룰 기반 폴백(오프라인/미연결)
    }

    var P = new URLSearchParams(location.search), CITY = P.get("city") || "";
    function page(){ var p = location.pathname.toLowerCase();
      if (/home\.html|\/$|index\.html/.test(p)) return "home";
      if (/compose/.test(p)) return "compose"; if (/glb-customizer/.test(p)) return "studio";
      if (/memory-walk/.test(p)) return "walk"; if (/vworld_map/.test(p)) return "map";
      if (/room-shopping/.test(p)) return "shop"; if (/region-select/.test(p)) return "region"; return "other"; }

    function ruleReply(text){
      var t = (text || "").toLowerCase();
      if (/테마|색|팔레트|분위기|톤|theme|컬러/.test(t) || text === "테마"){ addMsg("테마를 골라보세요.", "bot"); return themeChips(); }
      if (/밝|어둡|글씨|크게|작게|크기|폰트|zoom/.test(t)){ addMsg("글씨 크기를 조절해 드릴게요.", "bot"); return addChips([{label:"글씨 크게",act:"zoom",v:"1.12",say:1},{label:"글씨 작게",act:"zoom",v:"0.92",say:1}]); }
      if (/가벼|렉|느려|성능|lite/.test(t)){ return setLite(get(LS_LITE,"0")!=="1"); }
      // 학습 커스텀(방 안에서만): "X를 3번에 연결" 직접 연결, "추천/미배치/커스텀" → 추천 칩
      // 명령형만: "<개념>을/를 N번에 연결[해줘]" — 조사·'번'·끝 앵커 필수(질문/서술문 오매칭 방지)
      var mAssign = text && text.match(/^\s*(.+?)\s*(?:을|를|=|->|→)\s*(\d+)\s*번\s*(?:에|에다|핫스팟|지점)?\s*(?:연결|배치|넣어|매핑)(?:해|해줘|하기|해주세요)?[\s.!?]*$/);
      if (mAssign && typeof window.mpAssignConcept === "function"){
        var rc = window.mpAssignConcept(mAssign[2], mAssign[1].trim());
        if (rc && rc.ok){ addMsg("🔗 " + rc.n + "번 " + rc.object + "  ↔  '" + rc.concept + "' 연결했어요.", "bot"); if (rc.mnemonic) addMsg(rc.mnemonic, "bot"); }
        else { addMsg((rc && rc.reason) || "그 개념·지점을 찾지 못했어요.", "bot"); }
        return;
      }
      if (typeof window.mpRecommendations === "function" && /추천|미배치|더 배|배울|학습.*추천|커스텀|연결해|연결할/.test(t)){
        addMsg("아직 방에 없는 학습 항목이에요(🎯=미배치 우선). 누르면 빈 지점에 연결해 드려요:", "bot");
        return recoChips();
      }
      if (/핫스팟|hotspot|노드|마커|이 방|뭐가 있|뭐있|배치|지점|인식/.test(t)){
        var R = window.mpRoom;
        if (R && R.hotspots && R.hotspots.length){
          addMsg((R.roomName||"이 방")+"에 "+R.hotspots.length+"개 노드 — 핫스팟을 누르면 사물과 학습 개념의 의미를 만들어 드려요:", "bot");
          addChips(R.hotspots.slice(0,14).map(function(h){ return { label: h.n+". "+h.object+(h.concept?(" → "+h.concept):""), act:"hotspot", v:h.n, say:1 }; }));
          return;
        }
        addMsg("방에 들어가서 ➕ 지점으로 새 핫스팟을 찍으면, 객체를 인식하고 학습 개념과 연결해 드릴게요.", "bot");
        return;
      }
      if (/스튜디오|커스텀|꾸미|디자인|glb/.test(t)){ addMsg("'방 디자인 스튜디오'에서 방의 GLB·마커·학습을 깊이 꾸밀 수 있어요.", "bot"); return addChips([{label:"방 디자인 스튜디오 열기",act:"go",v:"glb-customizer.html",say:1}]); }
      if (/지도|3d|map|둘러/.test(t)){ addMsg("3D 지도에서 도시의 랜드마크를 둘러볼 수 있어요.", "bot"); return addChips([{label:"3D 지도 열기",act:"go",v:"vworld_map.html",say:1}]); }
      if (/업로드|pdf|학습|자료/.test(t)){ addMsg("학습 PDF는 외부에서 palace.json으로 변환돼요. 올리면 '구성' 화면에서 장소·방을 추천해 드려요.", "bot"); return addChips([{label:"구성 화면으로",act:"go",v:"compose.html",say:1}]); }
      if (/구성|추천|장소|방 골/.test(t)){ addMsg("'구성' 화면에서 챕터마다 어울리는 장소와 방을 고를 수 있어요.", "bot"); return addChips([{label:"구성 화면으로",act:"go",v:"compose.html",say:1}]); }
      if (/입장|시작|걷|walk|방으로/.test(t)){ addMsg("방으로 입장할까요? 아래 버튼을 누르면 이동해요.", "bot"); return addChips([{label:"▶ 방으로 입장", act:"enterFirst", say:1}]); }
      addMsg("테마·글씨 크기 변경, 화면 이동을 도와드려요.", "bot");
      themeChips(); navChips();
    }

    // 인사(페이지 맥락)
    var pg = page();
    // 위젯 위치: 모든 페이지를 브이월드 맵과 동일하게 좌하단으로 통일.
    (function place(){
      var L = document.getElementById("mpLaunch");
      function set(el, css){ for (var k in css) el.style[k] = css[k]; }
      set(L, { left: "16px", right: "auto", bottom: "150px" });
      set(panel, { left: "16px", right: "auto", bottom: "206px" });
    })();
    var hi = { home:"기억의 궁전에 오신 걸 환영해요. PDF를 올리면 학습을 궁전으로 구성해 드려요.",
      compose:"여기는 '구성' 화면이에요. 장소와 방을 골라 입장할 수 있어요.",
      studio:"여기는 '방 디자인 스튜디오'예요. 방 GLB·마커·학습을 꾸밀 수 있어요.",
      walk:"방 안이네요. 마커를 따라 걸으며 학습해 보세요.",
      map:"3D 지도예요. 핀을 눌러 방으로 입장할 수 있어요.",
      shop:"학습에 어울리는 방을 추천하는 화면이에요.",
      region:"도시를 골라 시작하는 화면이에요." }[pg] || "안녕하세요, 기억의 궁전 도우미예요.";
    addMsg(hi + " 무엇을 도와드릴까요?", "bot");
    addMsg("아래 바에서 테마·글씨, 화면 이동, 음성 안내를 바로 쓸 수 있어요.", "bot");
    if (pg === "walk") addChips([{ label: "✨ 의미 매치", act: "mnemonic", say: 0 }]);   // 의미부여(인룸 퀴즈는 지도 맵으로 이동)
    if (pg === "map") addChips([{ label: "📝 퀴즈 만들기", act: "quiz", say: 0 }]);   // 지도: 이 도시 학습내용으로 퀴즈

    function toggle(open){ panel.classList.toggle("open", open); set(LS_OPEN, open ? "1" : "0"); if (open){ input.focus(); try { window.mpTTS && window.mpTTS.warmup && window.mpTTS.warmup(); } catch (e) {} } }
    document.getElementById("mpLaunch").onclick = function(){ toggle(!panel.classList.contains("open")); };
    document.getElementById("mpClose").onclick = function(){ toggle(false); };
    document.getElementById("mpSend").onclick = function(){ var v = input.value.trim(); if (!v) return; addMsg(v, "me"); input.value = ""; setTimeout(function(){ getReply(v); }, 120); };
    // 챗봇 입력 중 키가 페이지로 새지 않게 차단 — 방 WASD 이동·지도 단축키가 같이 실행되거나(방) 입력이 막히던(지도) 문제 해결.
    // 한글 IME 조합 중 Enter는 '조합 확정'이므로 전송하지 않음(Mac에서 마지막 글자 중복 전송 방지)
    input.addEventListener("keydown", function(e){ e.stopPropagation(); if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) document.getElementById("mpSend").click(); });
    input.addEventListener("keyup", function(e){ e.stopPropagation(); });
    input.addEventListener("keypress", function(e){ e.stopPropagation(); });

    // ── 푸터 도구 아코디언(테마·글씨 / 화면 이동 / 음성 안내) — 한 번에 하나만 펼쳐 공간 절약 ──
    var TOOLS = [
      { btn: document.getElementById("mpThemeToggle"), opts: document.getElementById("mpThemeOpts") },
      { btn: document.getElementById("mpNavToggle"),   opts: document.getElementById("mpNavOpts") },
      { btn: document.getElementById("mpVoiceToggle"), opts: document.getElementById("mpVoiceOpts") }
    ];
    function openTool(which){ // which: 펼칠 opts 요소(없으면 전부 닫기)
      TOOLS.forEach(function(t){ if (!t.btn || !t.opts) return;
        var on = (t.opts === which);
        t.opts.hidden = !on;
        t.btn.setAttribute("aria-expanded", on ? "true" : "false");
      });
    }
    TOOLS.forEach(function(t){ if (t.btn && t.opts) t.btn.addEventListener("click", function(){ openTool(t.opts.hidden ? t.opts : null); }); });

    // 테마·글씨
    (function themeWire(){
      var tOpts = document.getElementById("mpThemeOpts"); if (!tOpts) return;
      markThemeActive();
      [].forEach.call(tOpts.querySelectorAll("[data-theme]"), function(b){ b.addEventListener("click", function(){ act({ act:"theme", v:b.getAttribute("data-theme") }); }); });
      [].forEach.call(tOpts.querySelectorAll("[data-zoom]"),  function(b){ b.addEventListener("click", function(){ act({ act:"zoom",  v:b.getAttribute("data-zoom") }); }); });
    })();

    // 화면 이동 (현재 화면 제외)
    (function navWire(){
      var nOpts = document.getElementById("mpNavOpts"); if (!nOpts) return;
      var DEST = [
        { label:"구성 화면", v:"compose.html" },
        { label:"방 디자인 스튜디오", v:"glb-customizer.html" },
        { label:"3D 지도", v:"vworld_map.html" },
        { label:"처음으로", v:"region-select.html" }
      ];
      var here = (location.pathname.split("/").pop() || "").toLowerCase();
      DEST.forEach(function(d){
        if (d.v.toLowerCase() === here) return;
        var b = document.createElement("button");
        b.type = "button"; b.textContent = d.label;
        b.addEventListener("click", function(){ act({ act:"go", v:d.v }); });
        nOpts.appendChild(b);
      });
    })();

    // ── 음성 안내(TTS) 컨트롤 배선 (mpTTS 엔진은 defer로 늦게 로드될 수 있어 상태를 재동기화) ──
    (function voiceWire(){
      var vMaster  = document.getElementById("mpVoiceMaster");
      var vGender  = document.getElementById("mpVoiceGender");
      var vSpatial = document.getElementById("mpVoiceSpatial");
      var vSpeeds  = [].slice.call(panel.querySelectorAll("#mpVoiceOpts [data-tts-speed]"));
      if (!vMaster) return;
      function syncState(){
        if (!window.mpTTS) return;
        var st = window.mpTTS.getState();
        vGender.textContent = "목소리: " + st.genderLabel;
        vGender.setAttribute("aria-label", "목소리 전환 (현재 " + st.genderLabel + ")");
        vSpeeds.forEach(function(b){ b.classList.toggle("is-active", b.getAttribute("data-tts-speed") === st.speed); });
        vSpatial.textContent = "공간음향: " + (st.spatial ? "켜기" : "끄기");
        vSpatial.setAttribute("aria-pressed", st.spatial ? "true" : "false");
        vSpatial.setAttribute("aria-label", st.spatial ? "공간음향 끄기" : "공간음향 켜기");
      }
      syncState(); setTimeout(syncState, 600); setTimeout(syncState, 1500); // 엔진 로드 후 따라잡기
      vMaster.addEventListener("click", function(){
        window.__mpVoiceOn = !window.__mpVoiceOn;
        vMaster.setAttribute("aria-pressed", window.__mpVoiceOn ? "true" : "false");
        vMaster.textContent = window.__mpVoiceOn ? "음성 안내 끄기" : "음성 안내 켜기";
        vMaster.setAttribute("aria-label", window.__mpVoiceOn ? "음성 안내 끄기" : "음성 안내 켜기");
        if (window.__mpVoiceOn && window.mpTTS){ syncState(); if (window.mpTTS.warmup) window.mpTTS.warmup(); window.mpTTS.speak("음성 안내를 켰습니다. 도우미의 답변을 읽어 드릴게요."); }
        else if (window.mpTTS){ window.mpTTS.stop(); }
      });
      vGender.addEventListener("click", function(){
        if (!window.mpTTS) return;
        var g = window.mpTTS.toggleGender();
        vGender.textContent = "목소리: " + g.label;
        vGender.setAttribute("aria-label", "목소리 전환 (현재 " + g.label + ")");
        if (window.__mpVoiceOn) window.mpTTS.speak(g.label + " 목소리로 읽어 드릴게요.");
      });
      vSpeeds.forEach(function(b){ b.addEventListener("click", function(){
        if (!window.mpTTS) return;
        var s = window.mpTTS.setSpeed(b.getAttribute("data-tts-speed"));
        vSpeeds.forEach(function(x){ x.classList.toggle("is-active", x === b); });
        if (window.__mpVoiceOn) window.mpTTS.speak("속도를 " + s.label + "로 맞췄어요.");
      }); });
      vSpatial.addEventListener("click", function(){
        if (!window.mpTTS) return;
        var on = window.mpTTS.toggleSpatial();
        vSpatial.textContent = "공간음향: " + (on ? "켜기" : "끄기");
        vSpatial.setAttribute("aria-pressed", on ? "true" : "false");
        vSpatial.setAttribute("aria-label", on ? "공간음향 끄기" : "공간음향 켜기");
        if (window.__mpVoiceOn) window.mpTTS.speak(on ? "공간음향을 켰습니다." : "공간음향을 껐습니다.");
      });
    })();

    if (get(LS_OPEN, "0") === "1") toggle(true);

    // 방에서 새 핫스팟이 인식되면(객체+좌표) 챗봇이 패널을 열고 알린 뒤 학습 개념과 의미를 연결한다.
    window.addEventListener("mp-hotspot-added", function (e) {
      var d = (e && e.detail) || {};
      toggle(true);
      addMsg("🔍 새 핫스팟 정의: '" + (d.object || "지점") + "'  ·  좌표(" + ((d.pos || []).join(", ")) + ")", "bot");
      if (d.concept) addMsg((d.bound ? "📚 '" + d.concept + "' 학습 항목을 이 지점에 연결했어요 — " : "'" + d.concept + "'과(와) 이렇게 연결해 보세요 — ") + (d.mnemonic || ""), "bot");
      else addMsg("학습 항목을 고르면 이 지점에 의미를 연결해 드릴게요.", "bot");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
