// defineBlock: ties a block's zod slots to its component props, so the schema and the TSX cannot drift apart.
import type { z } from "zod";
import type { BlockMeta } from "../types.js";

type PropsOf<C> = C extends (props: infer P) => unknown ? P : never;

/** Block meta whose slot schema must produce the props of `C` (`typeof Component`). */
export function defineBlock<C>() {
  return <S extends z.ZodType<Omit<PropsOf<C>, "wzId">>>(meta: BlockMeta<S>): BlockMeta<S> => meta;
}
