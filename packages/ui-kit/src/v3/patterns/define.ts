// definePattern: a variant of a section type folder — id, path in the system and the TSX text read next to the folder.
import { readFileSync } from "node:fs";
import type { z } from "zod";
import type { PatternMeta, SectionType } from "./types.js";

type PropsOf<C> = C extends (props: infer P) => unknown ? P : never;

export type PatternSpec<S extends z.ZodType> = Omit<PatternMeta<S>, "id" | "source" | "file" | "sectionType">;

/**
 * Pattern `<sectionType>-<variant>` from `<folder>/<variant>.tsx` (folder = the `import.meta.url` of its index.ts).
 * `C` is the type of the component (`typeof Component`): the slot schema must produce its props, so the schema and
 * the TSX cannot drift apart unnoticed by the compiler.
 */
export function definePattern<C>() {
  return <S extends z.ZodType<PropsOf<C>>>(
    folderUrl: string,
    sectionType: SectionType,
    spec: PatternSpec<S>,
  ): PatternMeta => {
    const id = `${sectionType}-${spec.variant}`;
    const source = readFileSync(new URL(`./${spec.variant}.tsx`, folderUrl), "utf8");
    return { ...spec, id, sectionType, file: `ui/patterns/${id}.tsx`, source };
  };
}
