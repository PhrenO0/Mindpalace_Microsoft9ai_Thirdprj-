/* 기억의 궁전 — TTS 음성 컨트롤 (접근성/포용성)
   · 도우미 챗봇의 목소리 전환 / 속도 / 공간음향 버튼과,
     학습 카드의 '듣기' 버튼이 공통으로 쓰는 엔진. window.mpTTS API 노출.
   · 기본 엔진: Azure Speech(자연스러운 HD 음성). 토큰/네트워크 불가 시
     브라우저 내장 음성(Web Speech API)으로 자동 폴백 → 로컬·오프라인에서도 동작.
   · Azure 사용 조건:
       1) (자동) Azure Speech JS SDK — 필요 시 CDN 자동 로드
       2) 토큰 엔드포인트(/api/speech-token). 백엔드 주소가 다르면
          페이지에서 window.MP_TTS_TOKEN_URL 로 절대 URL 지정.
   사용:  <script src="tts-controls.js" defer></script>
   음성: graphrag/tts/presets.json 과 동일(SunHi/Hyunsu HD).
   공간음향: 방 진입 위치·시선 기준 3D 좌표를 Web Audio HRTF PannerNode 로 재생.
     좌우·앞뒤·위아래와 거리를 반영하며, PannerNode 미지원 시 StereoPanner 로 폴백.
     브라우저 내장 TTS는 PCM 버퍼를 제공하지 않아 공간음향을 적용할 수 없음. */
(function () {
  "use strict";
  var LS_GENDER = "mp_tts_gender", LS_SPEED = "mp_tts_speed", LS_SPATIAL = "mp_tts_spatial";

  var VOICES = {
    female: { label: "여성", voice: "ko-KR-SunHi:DragonHDLatestNeural" },
    male:   { label: "남성", voice: "ko-KR-Hyunsu:DragonHDLatestNeural" }
  };
  var SPEEDS = {
    slow:   { label: "느리게", rate: "-15%", mult: 0.85 },
    normal: { label: "보통",   rate: "0%",   mult: 1.0  },
    fast:   { label: "빠르게", rate: "+15%", mult: 1.15 }
  };
  var DEFAULT_GENDER = "female", DEFAULT_SPEED = "normal";

  function get(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e){ return d; } }
  function set(k, v){ try { localStorage.setItem(k, v); } catch (e){} }

  var gender   = VOICES[get(LS_GENDER, DEFAULT_GENDER)] ? get(LS_GENDER, DEFAULT_GENDER) : DEFAULT_GENDER;
  var speed    = SPEEDS[get(LS_SPEED, DEFAULT_SPEED)] ? get(LS_SPEED, DEFAULT_SPEED) : DEFAULT_SPEED;
  var spatial  = get(LS_SPATIAL, "0") === "1";

  function tokenUrl(){ return window.MP_TTS_TOKEN_URL || "/api/speech-token"; }
  // window.MP_TTS_FORCE_BROWSER = true 면 Azure 건너뛰고 브라우저 음성만 사용
  function forceBrowser(){ return !!window.MP_TTS_FORCE_BROWSER; }

  // Azure Speech SDK 지연 로드(한 번만)
  var sdkPromise = null;
  function loadSDK(){
    if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject){
      var s = document.createElement("script");
      s.src = "https://aka.ms/csspeech/jsbrowserpackageraw";
      s.onload = function(){ window.SpeechSDK ? resolve(window.SpeechSDK) : reject(new Error("SpeechSDK 로드 실패")); };
      s.onerror = function(){ reject(new Error("SpeechSDK 스크립트 로드 실패")); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  // Web Audio 컨텍스트(공간음향·재생용). 사용자 클릭 시점에 생성/재개.
  var actx = null;
  function getCtx(){
    if (!actx){ var AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === "suspended") { try { actx.resume(); } catch (e){} }
    return actx;
  }

  function xmlEsc(s){ return String(s).replace(/[&<>"']/g, function(c){
    return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&apos;" })[c]; }); }

  function buildSsml(text){
    return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">' +
           '<voice name="' + VOICES[gender].voice + '">' +
           '<prosody rate="' + SPEEDS[speed].rate + '">' + xmlEsc(text) + '</prosody>' +
           '</voice></speak>';
  }

  // ── 토큰 캐싱(10분 유효 → 8분까지 재사용. 매 재생마다 재요청하던 지연 제거) ──
  var tokenCache = null, tokenExpiry = 0;
  function getToken(force){
    if (!force && tokenCache && Date.now() < tokenExpiry) return Promise.resolve(tokenCache);
    return fetch(tokenUrl()).then(function (r){
      if (!r.ok) throw new Error("토큰 발급 실패(" + r.status + ")");
      return r.json();
    }).then(function (tok){ tokenCache = tok; tokenExpiry = Date.now() + 8 * 60 * 1000; return tok; });
  }

  // ── 합성기 재사용(연결 유지 → 매번 핸드셰이크 안 함). 토큰 바뀌면 재생성 ──
  var synth = null, synthForToken = null;
  function getSynth(){
    return loadSDK().then(function (SDK){
      return getToken().then(function (tok){
        if (synth && synthForToken === tok.token) return synth;
        if (synth){ try { synth.close(); } catch (e){} synth = null; }
        var cfg = SDK.SpeechConfig.fromAuthorizationToken(tok.token, tok.region);
        cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
        synth = new SDK.SpeechSynthesizer(cfg, null); // null = 자동재생 안 함, audioData 반환
        synthForToken = tok.token;
        // 연결을 미리 열어 첫 합성 핸드셰이크 제거
        try { var conn = SDK.Connection.fromSynthesizer(synth); if (conn && conn.openConnection) conn.openConnection(); } catch (e){}
        return synth;
      });
    });
  }

  // 미리 준비: SDK 로드 + 토큰 + 오디오컨텍스트 + 연결 오픈 (사용자 동작 시점에 호출)
  function warmup(){
    if (forceBrowser()) return Promise.resolve();
    try { getCtx(); } catch (e){}
    return getSynth().then(function(){}).catch(function (e){ console.warn("[mpTTS] warmup:", e && e.message ? e.message : e); });
  }

  // text -> WAV(ArrayBuffer). 재사용 합성기로 합성(닫지 않음).
  function synthesize(text){
    return getSynth().then(function (sy){
      return new Promise(function (resolve, reject){
        sy.speakSsmlAsync(buildSsml(text), function (res){
          if (res && res.audioData && res.audioData.byteLength) resolve(res.audioData);
          else reject(new Error("합성 결과 없음"));
        }, function (err){ reject(err); });
      });
    });
  }

  var currentSrc = null;   // 진행 중 Azure 재생(중복 방지)
  function stop(){
    if (currentSrc){ try { currentSrc.stop(); } catch (e){} currentSrc = null; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e){}
  }

  function setAudioParam(param, value){
    if (param && typeof param.setValueAtTime === "function") param.setValueAtTime(value, actx.currentTime);
    else if (param) param.value = value;
  }

  // opts.position: 방 진입 위치·시선 기준 {x,y,z}. listener=(0,0,0), 정면=-Z.
  // opts.pan: 구형 호출 호환용 -1(왼)~+1(오). 3D PannerNode 미지원 시에도 사용.
  function speakAzure(text, opts){
    return synthesize(text).then(function (buf){
      var ctx = getCtx();
      if (!ctx) throw new Error("AudioContext 미지원");
      return ctx.decodeAudioData(buf.slice(0)).then(function (audioBuf){
        stop();
        var src = ctx.createBufferSource(); src.buffer = audioBuf;
        var pos = opts && opts.position;
        var has3D = spatial && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z) && ctx.createPanner;
        var pan = (opts && typeof opts.pan === "number") ? Math.max(-1, Math.min(1, opts.pan)) : 0;
        if (has3D){
          // 이 AudioContext는 TTS 전용이다. listener를 방 진입점의 로컬 원점에 고정하고
          // memory-walk가 변환한 사물 좌표만 움직여, 이후 카메라가 사물을 중앙에 둬도 음상이 유지된다.
          var listener = ctx.listener;
          if (listener.positionX){
            setAudioParam(listener.positionX, 0); setAudioParam(listener.positionY, 0); setAudioParam(listener.positionZ, 0);
            setAudioParam(listener.forwardX, 0); setAudioParam(listener.forwardY, 0); setAudioParam(listener.forwardZ, -1);
            setAudioParam(listener.upX, 0); setAudioParam(listener.upY, 1); setAudioParam(listener.upZ, 0);
          } else {
            listener.setPosition(0, 0, 0); listener.setOrientation(0, 0, -1, 0, 1, 0);
          }
          var p3 = ctx.createPanner();
          p3.panningModel = "HRTF"; p3.distanceModel = "inverse";
          p3.refDistance = Number.isFinite(opts.refDistance) ? opts.refDistance : 1.15;
          p3.maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 18;
          p3.rolloffFactor = Number.isFinite(opts.rolloffFactor) ? opts.rolloffFactor : 0.72;
          p3.coneInnerAngle = 360; p3.coneOuterAngle = 360; p3.coneOuterGain = 1;
          if (p3.positionX){
            setAudioParam(p3.positionX, pos.x); setAudioParam(p3.positionY, pos.y); setAudioParam(p3.positionZ, pos.z);
          } else p3.setPosition(pos.x, pos.y, pos.z);
          src.connect(p3); p3.connect(ctx.destination);
        } else if (spatial && ctx.createStereoPanner && pan !== 0){
          var panner = ctx.createStereoPanner(); panner.pan.value = pan;
          src.connect(panner); panner.connect(ctx.destination);
        } else {
          src.connect(ctx.destination);
        }
        currentSrc = src;
        src.onended = function(){ if (currentSrc === src) currentSrc = null; };
        src.start(0);
        return new Promise(function (resolve){ src.addEventListener("ended", function(){ resolve(); }); });
      });
    });
  }

  // ── 브라우저 내장 음성(Web Speech API) 폴백 ──
  function pickBrowserVoice(){
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    var ko = voices.filter(function (v){ return /^ko(-|_|$)/i.test(v.lang || ""); });
    if (!ko.length) ko = voices; // 한국어 음성 없으면 아무거나
    var femaleRe = /female|woman|여|유나|yuna|sun|hee|hyun(?!s)|seoyeon|nora|heami|jiyoung|grandma|sandy|shelley|flo/i;
    var maleRe   = /male|man|남|injoon|minsu|hyunsu|jinho|gangwon|grandpa|eddy|reed|rocko/i;
    var want = (gender === "female") ? femaleRe : maleRe;
    var avoid = (gender === "female") ? maleRe : femaleRe;
    var hit = ko.find(function (v){ return want.test(v.name || ""); });
    // 원하는 성별 매칭 실패 시: 반대 성별로 분류된 것만 피해서 다른 음성이라도 고름(로컬 남/여 구분용)
    if (!hit) hit = ko.find(function (v){ return !avoid.test(v.name || ""); });
    return hit || ko[0] || null;
  }
  function speakBrowser(text, opts){
    return new Promise(function (resolve){
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance){ resolve(); return; }
      try { window.speechSynthesis.cancel(); } catch (e){}
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = SPEEDS[speed].mult;
      var v = pickBrowserVoice();
      if (v) u.voice = v;
      u.onend = function(){ resolve(); };
      u.onerror = function(){ resolve(); };
      window.speechSynthesis.speak(u);
    });
  }
  // 일부 브라우저는 voices 를 비동기로 채움 → 미리 한 번 트리거
  if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === "function"){
    window.speechSynthesis.getVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== "undefined"){
      window.speechSynthesis.onvoiceschanged = function(){ window.speechSynthesis.getVoices(); };
    }
  }

  function speak(text, opts){
    text = (text || "").trim();
    if (!text) return Promise.resolve();
    opts = opts || {};
    if (forceBrowser()) return speakBrowser(text, opts);
    return speakAzure(text, opts).catch(function (e){
      console.warn("[mpTTS] Azure 실패 → 브라우저 음성으로 대체:", e && e.message ? e.message : e);
      return speakBrowser(text, opts);
    });
  }

  window.mpTTS = {
    speak: speak,
    stop: stop,
    warmup: warmup,
    toggleGender: function(){ gender = (gender === "female") ? "male" : "female"; set(LS_GENDER, gender); return { gender: gender, label: VOICES[gender].label }; },
    setGender: function(g){ if (VOICES[g]){ gender = g; set(LS_GENDER, g); } return { gender: gender, label: VOICES[gender].label }; },
    setSpeed: function(s){ if (SPEEDS[s]){ speed = s; set(LS_SPEED, s); } return { speed: speed, label: SPEEDS[speed].label }; },
    toggleSpatial: function(){ spatial = !spatial; set(LS_SPATIAL, spatial ? "1" : "0"); return spatial; },
    setSpatial: function(on){ spatial = !!on; set(LS_SPATIAL, spatial ? "1" : "0"); return spatial; },
    isSpatial: function(){ return spatial; },
    listenLabel: function(){ return spatial ? "공간음향 듣기" : "듣기"; },
    getState: function(){ return { gender: gender, genderLabel: VOICES[gender].label, speed: speed, speedLabel: SPEEDS[speed].label, spatial: spatial }; },
    voices: VOICES, speeds: SPEEDS,
    renderControls: function(container){
      if (!container) return;
      var st = this.getState(), self = this;
      container.innerHTML =
        '<button type="button" data-mptts="gender" aria-label="목소리 전환">🔊 목소리: ' + st.genderLabel + '</button>' +
        '<button type="button" data-mptts="slow" aria-label="느리게 읽기">느리게</button>' +
        '<button type="button" data-mptts="normal" aria-label="보통 속도로 읽기">보통</button>' +
        '<button type="button" data-mptts="fast" aria-label="빠르게 읽기">빠르게</button>';
      container.querySelectorAll("[data-mptts]").forEach(function (b){
        b.addEventListener("click", function(){
          var k = b.getAttribute("data-mptts");
          if (k === "gender"){ var g = self.toggleGender(); b.textContent = "🔊 목소리: " + g.label; }
          else { self.setSpeed(k); }
        });
      });
    }
  };
})();
