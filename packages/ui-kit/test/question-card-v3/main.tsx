/// <reference types="vite/client" />
// V3-03 browser test page: the question card of the v3 interview (why the recommendation, «Решите за меня», «Дальше
// решай сам») next to a v2 card without the new props. ?theme=light|dark. The last action is written to [data-testid=said].
import "../../src/v2/theme.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Glass, QuestionCard, ThemeRoot } from "../../src/v2/index.js";

const params = new URLSearchParams(window.location.search);

const V3_OPTIONS = [
  { id: "o1", label: "Имя и телефон", recommended: true },
  { id: "o2", label: "Имя, телефон и почта" },
  { id: "o3", label: "Только телефон" },
  { id: "o4", label: "Имя, телефон и дата рождения" },
];
const V2_OPTIONS = [
  { id: "online", label: "Онлайн-запись", recommended: true },
  { id: "phone", label: "Запись по телефону" },
];

function App() {
  const [said, setSaid] = useState("");
  return (
    <ThemeRoot theme={params.get("theme") === "dark" ? "dark" : "light"} motion={false}>
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px", display: "grid", gap: 16 }}>
        <Glass>
          <QuestionCard
            testId="v3-card"
            step="Вопрос 3"
            question="Какие данные пациента нужны для записи?"
            hint="От этого зависят поля формы, кто что видит и как долго хранятся персональные данные."
            options={V3_OPTIONS}
            selected={[]}
            onToggle={(id) => setSaid(`option:${id}`)}
            recommendationWhy="Имени и телефона хватает, чтобы подтвердить запись. Почту можно добавить потом."
            onDelegate={() => setSaid("delegate")}
            onFinish={() => setSaid("finish")}
          />
        </Glass>
        <Glass>
          <QuestionCard
            testId="v2-card"
            step="Вопрос 2 из 5"
            question="Как пациенты будут записываться?"
            options={V2_OPTIONS}
            selected={[]}
            onToggle={() => {}}
            onSubmit={() => {}}
          />
        </Glass>
        <p data-testid="said">{said}</p>
      </main>
    </ThemeRoot>
  );
}

const el = document.getElementById("root");
if (el)
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
(window as unknown as { __wz: { ready: boolean } }).__wz = { ready: true };
