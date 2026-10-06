// compile.ts of «Каталог и прайс» (manifest.hook): the service entity with its fields in showcase order (name, price,
// duration, category, visibility, description, photo) and the optional service_category entity. Field order matters to
// the cabinet's table (first six columns), which conditional field fragments could only append to the end.
import type { Entity, Field, ModuleFragments } from "@wizard/appspec";
import type { ModuleContext } from "../types.js";

/** Canonical names other modules and the goal panel rely on (booking reads service.duration_min). */
export const CATALOG_NAMES = {
  item: "service",
  category: "service_category",
  title: "name",
  price: "price",
  duration: "duration_min",
  categoryRef: "category",
  active: "active",
  photo: "photo",
  description: "description",
  sortOrder: "sort_order",
} as const;

const N = CATALOG_NAMES;

/**
 * The showcase component: the page /services is ui/pages/CatalogServices.tsx (engine naming) and exports it, so the
 * landing section «Услуги из каталога» renders the same component from ui/pages/Home.tsx.
 */
export const SHOWCASE = {
  route: "/services",
  component: "ServiceShowcase",
  importFrom: "./CatalogServices",
} as const;

/** Catalog parameters with defaults, as the hook and the screens read them. */
export interface CatalogOptions {
  itemLabel: string;
  showPrices: boolean;
  withDuration: boolean;
  withCategories: boolean;
  withPhotos: boolean;
  showcaseTitle: string;
  /** Extra fields of the plan include e-mail or phone (pii basic): the item needs a retention term. */
  contactExtras: boolean;
}

export function catalogOptions(params: Readonly<Record<string, unknown>>): CatalogOptions {
  const extras = (params.extra_fields ?? []) as { type?: string }[];
  return {
    itemLabel: String(params.item_label ?? "Услуга"),
    showPrices: params.show_prices !== false,
    withDuration: params.with_duration === true,
    withCategories: params.with_categories === true,
    withPhotos: params.with_photos !== false,
    showcaseTitle: String(params.showcase_title ?? "Услуги и цены"),
    contactExtras: extras.some((x) => x.type === "email" || x.type === "phone"),
  };
}

/** Fields of the catalog item in showcase order; conditional ones only when their parameter is on. */
export function serviceFields(o: CatalogOptions): Field[] {
  const fields: Field[] = [
    { name: N.title, label: "Название", type: "string", required: true, maxLength: 120 },
    { name: N.price, label: "Цена, ₽", type: "money", min: 0 },
  ];
  if (o.withDuration)
    fields.push({
      name: N.duration,
      label: "Длительность, мин",
      type: "int",
      required: true,
      min: 5,
      max: 720,
    });
  if (o.withCategories)
    fields.push({
      name: N.categoryRef,
      label: "Раздел",
      type: "ref",
      ref: { entity: N.category, onDelete: "set_null" },
    });
  fields.push(
    { name: N.active, label: "На витрине", type: "bool", required: true, default: true },
    { name: N.description, label: "Описание", type: "text", maxLength: 1000 },
  );
  if (o.withPhotos) fields.push({ name: N.photo, label: "Фото", type: "image" });
  fields.push({ name: N.sortOrder, label: "Порядок на витрине", type: "int", min: 0, max: 9999 });
  return fields;
}

export function compileCatalog(ctx: ModuleContext): ModuleFragments {
  const o = catalogOptions(ctx.params);
  const entities: Entity[] = [];
  if (o.withCategories)
    entities.push({
      name: N.category,
      label: "Раздел каталога",
      fields: [
        { name: N.title, label: "Название", type: "string", required: true, maxLength: 80 },
        { name: N.sortOrder, label: "Порядок на витрине", type: "int", min: 0, max: 9999 },
      ],
    });
  entities.push({
    name: N.item,
    label: o.itemLabel,
    fields: serviceFields(o),
    indexes: [
      { fields: [N.active, N.sortOrder] },
      ...(o.withCategories ? [{ fields: [N.categoryRef] }] : []),
    ],
    // Contact extra fields are personal data: they are cleared after ten years, the item itself stays.
    ...(o.contactExtras ? { retention: { deleteAfterDays: 3650, mode: "anonymize" as const } } : {}),
  });
  return { entities: entities.map((value) => ({ value })) };
}
