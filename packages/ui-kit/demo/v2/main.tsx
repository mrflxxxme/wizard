/// <reference types="vite/client" />
// Demo of the platform design system v2 (ui-kit.yaml#platform_v2.demo): every v2 component in its states.
// URL: ?theme=auto|light|dark&biz=%23RRGGBB|none&glass=off&motion=off&sheet=inline&history=open (the chat sheet in the page flow,
// for full-page screenshots; by default it floats bottom-centre like on the canvas)
import "../../src/v2/theme.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ActionButton,
  CanvasBlock,
  type CanvasBlockState,
  ChatMessage,
  ChatSheet,
  Chip,
  Composer,
  DEMO_BUSINESS_COLOR,
  Glass,
  type PlatformThemeMode,
  QuestionCard,
  Serif,
  SketchText,
  Tag,
  ThemeRoot,
  XrayLines,
} from "../../src/v2/index.js";
import s from "./demo.module.css";

const params = new URLSearchParams(window.location.search);
const bizParam = params.get("biz");

const OPTIONS = [
  { id: "online", label: "Онлайн-запись", recommended: true },
  { id: "phone", label: "Запись по телефону" },
  { id: "both", label: "И так, и так" },
];
const XRAY = {
  nodes: [
    { id: "book", x: 170, y: 70, label: "Пациент записался" },
    { id: "remind", x: 500, y: 230, label: "Напоминание за день" },
    { id: "cab", x: 830, y: 70, label: "Запись в кабинете врача" },
  ],
  edges: [
    ["book", "remind"],
    ["remind", "cab"],
  ] as const,
};

const NEXT_THEME = { auto: "light", light: "dark", dark: "auto" } as const;
const THEME_LABEL = { auto: "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" } as const;

function Block({
  state,
  title,
  onMaterialized,
  delayMs,
  selected,
  onSelect,
}: {
  state: CanvasBlockState;
  title: string;
  onMaterialized?(): void;
  delayMs?: number;
  selected?: boolean;
  onSelect?(): void;
}) {
  return (
    <CanvasBlock
      state={state}
      label={title}
      testId={`demo-block-${title}`}
      selected={selected ?? false}
      {...(onMaterialized ? { onMaterialized } : {})}
      {...(delayMs ? { delayMs } : {})}
      {...(onSelect ? { onSelect } : {})}
    >
      <span className={s.blockHead}>
        <SketchText>{title}</SketchText>
      </span>
      <span className={s.blockText}>
        <SketchText lines>Онлайн-запись к врачу на удобное время, напоминание за день до визита.</SketchText>
      </span>
      <span className={s.slots}>
        <span className={s.slot}>10:00</span>
        <span className={`${s.slot} ${s.slotOn}`}>11:30</span>
        <span className={s.slot}>14:00</span>
      </span>
    </CanvasBlock>
  );
}

function Demo() {
  const [theme, setTheme] = useState<PlatformThemeMode>(
    (params.get("theme") as PlatformThemeMode | null) ?? "auto",
  );
  const [biz, setBiz] = useState<string | null>(
    bizParam === "none" ? null : (bizParam ?? DEMO_BUSINESS_COLOR),
  );
  const [run, setRun] = useState(0);
  const [live, setLive] = useState<CanvasBlockState>("materializing");
  const [selected, setSelected] = useState(false);
  const [xray, setXray] = useState(true);
  const [answer, setAnswer] = useState<string[]>(["online"]);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(params.get("history") === "open");
  const [sent, setSent] = useState<{ id: number; text: string }[]>([]);
  return (
    <ThemeRoot
      theme={theme}
      business={biz}
      glass={params.get("glass") !== "off"}
      motion={params.get("motion") !== "off"}
      className={s.page}
    >
      <main className={s.wrap}>
        <Glass as="header" className={s.top}>
          <span className={s.brand}>Born to Build</span>
          <Serif as="h1" size="md">
            Клиника «Светлая»
          </Serif>
          <span className={s.grow} />
          <ActionButton
            variant="ghost"
            size="sm"
            testId="demo-theme"
            onClick={() => setTheme(NEXT_THEME[theme])}
          >
            {THEME_LABEL[theme]}
          </ActionButton>
          <ActionButton
            variant="ghost"
            size="sm"
            testId="demo-biz"
            aria-pressed={biz !== null}
            onClick={() => setBiz(biz ? null : DEMO_BUSINESS_COLOR)}
          >
            {biz ? "Цвет платформы" : "Цвет бизнеса"}
          </ActionButton>
        </Glass>

        <section className={s.section} aria-labelledby="h-buttons">
          <h2 id="h-buttons" className={s.h}>
            Кнопки, варианты и метки
          </h2>
          <div className={s.row}>
            <ActionButton variant="primary">Утвердить план</ActionButton>
            <ActionButton>Изменить</ActionButton>
            <ActionButton variant="create" testId="demo-create" busy={live === "materializing"}>
              Собрать систему
            </ActionButton>
            <ActionButton variant="ghost">Подробнее</ActionButton>
          </div>
          <div className={s.row}>
            <Chip pressed>Онлайн-запись</Chip>
            <Chip pressed={false} recommended>
              Напоминания
            </Chip>
            <Chip tone="outline">Стоматология</Chip>
            <Tag kind="goal" note="неявок меньше 5%">
              Цель
            </Tag>
            <Tag kind="out">Оплата онлайн</Tag>
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-canvas">
          <h2 id="h-canvas" className={s.h}>
            Холст: эскиз, материализация, готов, выбран
          </h2>
          <div className={s.row}>
            <ActionButton
              size="sm"
              testId="demo-replay"
              onClick={() => {
                setLive("materializing");
                setRun((n) => n + 1);
              }}
            >
              Повторить материализацию
            </ActionButton>
            <ActionButton size="sm" testId="demo-xray" aria-pressed={xray} onClick={() => setXray(!xray)}>
              Как это работает
            </ActionButton>
          </div>
          <div className={s.board} data-testid="demo-board">
            <Block state="sketch" title="Эскиз" />
            <Block key={run} state={live} title="Запись" onMaterialized={() => setLive("ready")} />
            <Block state="ready" title="Врачи" onSelect={() => setSelected(!selected)} selected={selected} />
            <Block state="ready" title="Услуги" selected onSelect={() => {}} />
            <XrayLines width={1000} height={300} nodes={XRAY.nodes} edges={XRAY.edges} visible={xray} />
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-convo">
          <h2 id="h-convo" className={s.h}>
            Строка ввода и вопрос
          </h2>
          <div className={s.convo}>
            <div className={s.panel}>
              <Serif as="p" size="xl" className={s.hello}>
                Добрый день
              </Serif>
              <Composer
                testId="demo-composer-start"
                size="start"
                value=""
                onChange={() => {}}
                onSubmit={() => {}}
              />
              <div className={s.examples}>
                <Chip tone="outline">Стоматология</Chip>
                <Chip tone="outline">Автосервис</Chip>
              </div>
            </div>
            <Glass className={s.panel}>
              <QuestionCard
                step="Вопрос 2 из 5"
                question="Как пациенты будут записываться?"
                options={OPTIONS}
                selected={answer}
                onToggle={(id) => setAnswer([id])}
                onSubmit={() => {}}
              />
              <Composer
                testId="demo-composer-thinking"
                state="thinking"
                value=""
                placeholder="Свой ответ"
                onChange={() => {}}
                onSubmit={() => {}}
              />
            </Glass>
            <Glass className={s.panel}>
              <Composer
                testId="demo-composer-target"
                value=""
                placeholder="Что поменять в блоке?"
                target={{ label: "Услуги и цены", onClear: () => {} }}
                suggestions={[
                  { id: "view", label: "Другой вид" },
                  { id: "remove", label: "Убрать" },
                ]}
                onChange={() => {}}
                onSubmit={() => {}}
              />
              <Composer
                testId="demo-composer-building"
                state="building"
                value=""
                placeholder="Собираю систему…"
                onChange={() => {}}
                onSubmit={() => {}}
              />
            </Glass>
          </div>
        </section>
      </main>

      <ChatSheet
        position={params.get("sheet") === "inline" ? "inline" : "fixed"}
        className={params.get("sheet") === "inline" ? s.inlineSheet : undefined}
        open={open}
        onOpenChange={setOpen}
        history={
          <>
            <ChatMessage from="me">Стоматология: онлайн-запись и напоминания пациентам</ChatMessage>
            <ChatMessage from="ai">Соберу сайт с записью, кабинет врача и напоминания.</ChatMessage>
            <ChatMessage from="sys">План обновлён: добавлены напоминания</ChatMessage>
            <ChatMessage from="sys" tone="warn">
              Оплату онлайн пока не подключаем
            </ChatMessage>
            {sent.map((m) => (
              <ChatMessage key={m.id} from="me">
                {m.text}
              </ChatMessage>
            ))}
          </>
        }
      >
        <Composer
          value={text}
          placeholder="Свой ответ"
          onChange={setText}
          onSubmit={(t) => {
            setSent((x) => [...x, { id: x.length + 1, text: t }]);
            setText("");
          }}
        />
      </ChatSheet>
    </ThemeRoot>
  );
}

const el = document.getElementById("root");
if (el)
  createRoot(el).render(
    <StrictMode>
      <Demo />
    </StrictMode>,
  );
// Ready flag of the demo harness (test/helpers/demo.ts).
(window as unknown as { __wz: { ready: boolean } }).__wz = { ready: true };
