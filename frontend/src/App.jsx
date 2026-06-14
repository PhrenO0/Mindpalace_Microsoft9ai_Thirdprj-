import "./styles.css";

const LEGACY_ENTRY = "/legacy/vworld_landmarks.html";

export default function App() {
  return (
    <main className="legacy-app">
      <iframe
        title="광화문 기억궁전"
        src={LEGACY_ENTRY}
        className="legacy-frame"
        allow="fullscreen"
      />
    </main>
  );
}
