// Owner-facing texts of destructive prod changes (M2-72, D56/D72; D28/D48 — plain words, no jargon): what is removed,
// how many records it touches, that values stay in the archive and the change can be undone.
import type { DestructiveChange, FieldType } from "@wizard/appspec";

/** 1 запись, 2 записи, 5 записей. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const records = (n: number) => `${n} ${plural(n, "запись", "записи", "записей")}`;
/** Prepositional: «в 1 записи», «в 2 записях». */
const inRecords = (n: number) => `${n} ${plural(n, "записи", "записях", "записях")}`;
const values = (n: number) => `${n} ${plural(n, "значение", "значения", "значений")}`;

const TYPE_RU: Partial<Record<FieldType, string>> = {
  string: "строка",
  text: "текст",
  int: "целое число",
  decimal: "число",
  money: "сумма",
  bool: "да/нет",
  date: "дата",
  datetime: "дата и время",
  enum: "список",
  ref: "ссылка",
  file: "файл",
  json: "данные",
  email: "почта",
  phone: "телефон",
  url: "адрес сайта",
  qr_token: "QR-код",
};

const typeRu = (t: FieldType | undefined) => (t ? (TYPE_RU[t] ?? t) : "");
const UNDO = "Значения сохранятся в архиве, правку можно отменить.";

/** Does the change stop the publication until the data is fixed (a new rule existing rows break)? */
export function isBlocking(c: DestructiveChange, affected: number): boolean {
  if (c.kind === "alter_check") return affected > 0;
  if (c.kind === "set_not_null") return affected > 0 && c.hasDefault !== true;
  return false;
}

export function consequenceText(c: DestructiveChange, affected: number, unconvertible: number): string {
  const field = `поля „${c.fieldLabel ?? c.field ?? ""}“`;
  const where = `в разделе „${c.entityLabel}“`;
  switch (c.kind) {
    case "drop_table":
      return affected > 0
        ? `Удаление раздела „${c.entityLabel}“ затронет ${records(affected)}. Записи сохранятся в архиве, правку можно отменить.`
        : `Раздел „${c.entityLabel}“ будет удалён, записей в нём нет. Правку можно отменить.`;
    case "drop_column":
      return affected > 0
        ? `Удаление ${field} ${where} затронет ${records(affected)}. ${UNDO}`
        : `Поле „${c.fieldLabel ?? c.field}“ ${where} будет удалено, оно нигде не заполнено. Правку можно отменить.`;
    case "alter_column_type": {
      const types = c.fromType === c.toType ? "" : ` (${typeRu(c.fromType)} → ${typeRu(c.toType)})`;
      const what =
        c.fromType === c.toType ? `Смена связи ${field} ${where}` : `Смена типа ${field} ${where}${types}`;
      if (affected === 0) return `${what} не затронет ни одной записи.`;
      const lost =
        unconvertible > 0
          ? ` ${values(unconvertible)} нельзя перенести в новый тип — ${plural(unconvertible, "оно останется", "они останутся", "они останутся")} только в архиве${c.hasDefault ? ", в записях будет значение по умолчанию" : ", в записях поле станет пустым"}.`
          : "";
      return `${what} затронет ${records(affected)}.${lost} Прежние значения сохранятся в архиве, правку можно отменить.`;
    }
    case "set_not_null":
      if (affected === 0) return `Поле „${c.fieldLabel ?? c.field}“ ${where} станет обязательным.`;
      return c.hasDefault
        ? `Поле „${c.fieldLabel ?? c.field}“ ${where} станет обязательным: в ${inRecords(affected)} пустое значение заменится значением по умолчанию.`
        : `Поле „${c.fieldLabel ?? c.field}“ ${where} станет обязательным, но в ${inRecords(affected)} оно пустое. Заполните эти записи или задайте значение по умолчанию — до этого правку не опубликовать.`;
    case "alter_check":
      return affected > 0
        ? `Новое правило для ${field} ${where} не выполняется в ${inRecords(affected)}. Исправьте эти записи или смягчите правило — до этого правку не опубликовать.`
        : `Для ${field} ${where} появится новое правило; все записи ему соответствуют.`;
  }
}
