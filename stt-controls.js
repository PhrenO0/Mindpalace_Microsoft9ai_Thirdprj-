/* Mindpalace chatbot STT add-on.
   Load after assistant.js, or anywhere with defer. It adds a microphone button
   beside #mpSend and writes one recognized Korean utterance into #mpInput. */
(function () {
  "use strict";

  if (window.mpSTT) return;

  function tokenUrl() {
    return window.MP_STT_TOKEN_URL || window.MP_TTS_TOKEN_URL || "/api/speech-token";
  }

  function loadSDK() {
    if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
    if (window.__mpSpeechSdkPromise) return window.__mpSpeechSdkPromise;

    window.__mpSpeechSdkPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://aka.ms/csspeech/jsbrowserpackageraw";
      script.onload = function () {
        if (window.SpeechSDK) resolve(window.SpeechSDK);
        else reject(new Error("Azure Speech SDK를 불러오지 못했어요."));
      };
      script.onerror = function () {
        reject(new Error("Azure Speech SDK를 불러오지 못했어요."));
      };
      document.head.appendChild(script);
    });
    return window.__mpSpeechSdkPromise;
  }

  function recognizeOnce() {
    return fetch(tokenUrl()).then(function (response) {
      if (!response.ok) throw new Error("음성 토큰 발급 실패(" + response.status + ")");
      return response.json();
    }).then(function (tokenData) {
      return loadSDK().then(function (SDK) {
        var speechConfig = SDK.SpeechConfig.fromAuthorizationToken(tokenData.token, tokenData.region);
        speechConfig.speechRecognitionLanguage = "ko-KR";
        var audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
        var recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

        return new Promise(function (resolve, reject) {
          function close() {
            try { recognizer.close(); } catch (_) {}
            try { audioConfig.close(); } catch (_) {}
          }

          recognizer.recognizeOnceAsync(function (result) {
            close();
            if (result && result.reason === SDK.ResultReason.RecognizedSpeech && (result.text || "").trim()) {
              resolve(result.text.trim());
            } else if (result && result.reason === SDK.ResultReason.NoMatch) {
              reject(new Error("음성을 알아듣지 못했어요. 다시 말해 주세요."));
            } else {
              reject(new Error("음성 인식 결과가 없어요."));
            }
          }, function (error) {
            close();
            reject(new Error(String(error || "음성 인식에 실패했어요.")));
          });
        });
      });
    });
  }

  function addStyles() {
    if (document.getElementById("mp-stt-style")) return;
    var style = document.createElement("style");
    style.id = "mp-stt-style";
    style.textContent =
      ".mp-foot .mp-stt-mic{border:1px solid var(--line);border-radius:50%;width:36px;height:36px;" +
      "flex:0 0 36px;cursor:pointer;background:var(--panel2,#fff);color:var(--text);" +
      "display:flex;align-items:center;justify-content:center;padding:0;line-height:0}" +
      ".mp-foot .mp-stt-mic svg{width:18px;height:18px;display:block}" +
      ".mp-foot .mp-stt-mic.listening{background:var(--accent,#b5552f);color:#fff;animation:mpSttPulse 1s ease-in-out infinite}" +
      ".mp-foot .mp-stt-mic:disabled{cursor:wait;opacity:.72}" +
      ".mp-stt-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;" +
      "clip:rect(0,0,0,0);white-space:nowrap;border:0}" +
      "@keyframes mpSttPulse{50%{transform:scale(.9);opacity:.72}}";
    document.head.appendChild(style);
  }

  function install() {
    if (document.getElementById("mpSttMic")) return true;
    var input = document.getElementById("mpInput");
    var send = document.getElementById("mpSend");
    if (!input || !send || !send.parentNode) return false;

    addStyles();
    var mic = document.createElement("button");
    mic.id = "mpSttMic";
    mic.className = "mp-stt-mic";
    mic.type = "button";
    // 이모지(🎙 U+1F399)는 변형선택자가 없어 일부 환경에서 텍스트형 글리프(깨진 구체)로
    // 렌더되므로, 어디서나 동일하게 보이는 인라인 SVG 마이크로 대체한다(currentColor=테마색).
    mic.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">' +
      '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>' +
      '<path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2h-3v-2.08A7 7 0 0 0 19 11z"/>' +
      '</svg>';
    mic.title = "음성으로 입력";
    mic.setAttribute("aria-label", "음성으로 입력");
    mic.setAttribute("aria-pressed", "false");

    var status = document.createElement("span");
    status.className = "mp-stt-sr";
    status.setAttribute("aria-live", "polite");
    send.parentNode.insertBefore(mic, send);
    send.parentNode.appendChild(status);

    mic.addEventListener("click", function () {
      if (mic.disabled) return;
      mic.disabled = true;
      mic.classList.add("listening");
      mic.setAttribute("aria-pressed", "true");
      mic.setAttribute("aria-label", "음성 인식 중");
      status.textContent = "듣고 있습니다. 말씀해 주세요.";

      recognizeOnce().then(function (text) {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        status.textContent = "음성이 입력창에 입력되었습니다.";
      }).catch(function (error) {
        console.error("[mpSTT]", error);
        status.textContent = (error && error.message) || "음성 인식에 실패했습니다.";
        window.alert(status.textContent + " 마이크 권한과 음성 서버 설정을 확인해 주세요.");
      }).then(function () {
        mic.disabled = false;
        mic.classList.remove("listening");
        mic.setAttribute("aria-pressed", "false");
        mic.setAttribute("aria-label", "음성으로 입력");
      });
    });
    return true;
  }

  window.mpSTT = { recognizeOnce: recognizeOnce, install: install };

  if (!install()) {
    var observer = new MutationObserver(function () {
      if (install()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
