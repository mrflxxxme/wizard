import { Button } from "../../src/index.js";
import type { Story } from "../story.js";
import styles from "./stories.module.css";

export default {
  component: "Button",
  spec: "forum",
  role: null,
  render: () => (
    <div className={styles.row}>
      <Button variant="primary">Оформить билет</Button>
      <Button>Отмена</Button>
      <Button variant="ghost">Подробнее</Button>
      <Button variant="danger">Удалить</Button>
      <Button variant="primary" loading>
        Сохранение
      </Button>
      <Button disabled>Недоступно</Button>
      <Button href="#program">Программа</Button>
    </div>
  ),
} satisfies Story;
