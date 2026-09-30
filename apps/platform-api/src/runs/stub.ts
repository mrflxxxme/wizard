// Placeholder executors until packages/agents is wired in (M0-26).
import { type RunExecutors, RunFailure } from "./types.js";

export const stubExecutors: RunExecutors = {
  async interviewTurn() {
    return {
      kind: "answer",
      text: "Сообщение сохранено. Агент-интервьюер пока не подключён к платформе — ответ появится после его подключения.",
    };
  },
  async build() {
    throw new RunFailure("INTERNAL", "Сборщик пока не подключён к платформе. Попробуйте позже.", true);
  },
};
