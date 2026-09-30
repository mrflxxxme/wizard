import { Badge } from "../../src/index.js";
import type { Story } from "../story.js";
import styles from "./stories.module.css";

export default {
  component: "Badge",
  spec: "forum",
  role: null,
  render: () => (
    <div className={styles.row}>
      <Badge>Черновик</Badge>
      <Badge tone="accent">Новое</Badge>
      <Badge tone="ok">Оплачено</Badge>
      <Badge tone="warn">Осталось 5 мест</Badge>
      <Badge tone="bad">Отклонено</Badge>
    </div>
  ),
} satisfies Story;
