// Slot primitives shared by the pattern folders: links, images and texts with limits that keep layouts intact.
import { z } from "zod";

/** Same-origin path: photos live in the system's storage, no hotlinks to other CDNs (catalog I08, 152-ФЗ). */
export const SAME_ORIGIN_PATH_RE = /^\/(?!\/)[^\s"'<>]*$/;
/** Page path, anchor, phone, e-mail or an https link (messengers, maps). */
export const HREF_RE =
  /^(?:\/(?!\/)[^\s"'<>]*|#[\w-]+|tel:\+?[\d-]{5,20}|mailto:[^\s"'<>]+|https:\/\/[^\s"'<>]+)$/;

/** A text of 1..max characters without line breaks. */
export const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\n]*$/);

/** A paragraph of 1..max characters. */
export const para = (max: number) => z.string().min(1).max(max);

export const linkSlot = z.object({
  label: line(40),
  href: z.string().regex(HREF_RE, "ссылка: путь, якорь, tel:, mailto: или https://"),
});

export const imageSlot = z.object({
  src: z.string().regex(SAME_ORIGIN_PATH_RE, "фото только с домена системы"),
  /** Meaningful alternative text (catalog A08). */
  alt: line(200),
});

export const brandSlot = z.object({
  name: line(60),
  href: z.string().regex(HREF_RE).optional(),
  logo: imageSlot.optional(),
});
