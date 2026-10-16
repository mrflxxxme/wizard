// Block library v4 (V5-01): the catalog the director reads — slots, variants, descriptions — and the components.

import AboutStory, { block as aboutStory } from "./about/story.js";
import CatalogCards, { block as catalogCards } from "./catalog/cards.js";
import ContactsSplit, { block as contactsSplit } from "./contacts/split.js";
import CtaBand, { block as ctaBand } from "./cta/band.js";
import FaqAccordion, { block as faqAccordion } from "./faq/accordion.js";
import FeaturesBento, { block as featuresBento } from "./features/bento.js";
import FeaturesGrid, { block as featuresGrid } from "./features/grid.js";
import FooterColumns, { block as footerColumns } from "./footer/columns.js";
import GalleryMosaic, { block as galleryMosaic } from "./gallery/mosaic.js";
import HeroAurora, { block as heroAurora } from "./hero/aurora.js";
import HeroShader, { block as heroShader } from "./hero/shader.js";
import HeroSplitMedia, { block as heroSplitMedia } from "./hero/split-media.js";
import LogosStrip, { block as logosStrip } from "./logos/strip.js";
import NavBar, { block as navBar } from "./nav/bar.js";
import PricingTiers, { block as pricingTiers } from "./pricing/tiers.js";
import ServicesList, { block as servicesList } from "./services/list.js";
import StatsCountup, { block as statsCountup } from "./stats/countup.js";
import StepsTimeline, { block as stepsTimeline } from "./steps/timeline.js";
import TestimonialsMarquee, { block as testimonialsMarquee } from "./testimonials/marquee.js";
import TestimonialsQuote, { block as testimonialsQuote } from "./testimonials/quote.js";
import type { BlockMeta } from "./types.js";

export { ICON_NAMES, Icon, type IconName } from "./kit/icons.js";
export { MOTION_MIN_WIDTH, Reveal, useStill } from "./kit/motion.js";
export type { BlockEffect, BlockKind, BlockMeta, BlockOrigin, BlockVariant } from "./types.js";
export { BLOCK_KINDS } from "./types.js";

/** Every block of the library with its component, in catalog order. */
export const BLOCKS = [
  { meta: aboutStory, Component: AboutStory },
  { meta: catalogCards, Component: CatalogCards },
  { meta: contactsSplit, Component: ContactsSplit },
  { meta: ctaBand, Component: CtaBand },
  { meta: faqAccordion, Component: FaqAccordion },
  { meta: featuresBento, Component: FeaturesBento },
  { meta: featuresGrid, Component: FeaturesGrid },
  { meta: footerColumns, Component: FooterColumns },
  { meta: galleryMosaic, Component: GalleryMosaic },
  { meta: heroAurora, Component: HeroAurora },
  { meta: heroShader, Component: HeroShader },
  { meta: heroSplitMedia, Component: HeroSplitMedia },
  { meta: logosStrip, Component: LogosStrip },
  { meta: navBar, Component: NavBar },
  { meta: pricingTiers, Component: PricingTiers },
  { meta: servicesList, Component: ServicesList },
  { meta: statsCountup, Component: StatsCountup },
  { meta: stepsTimeline, Component: StepsTimeline },
  { meta: testimonialsMarquee, Component: TestimonialsMarquee },
  { meta: testimonialsQuote, Component: TestimonialsQuote },
] as const satisfies readonly { meta: BlockMeta; Component: (props: never) => unknown }[];

/** Catalog entry by id (`hero-shader`, `faq-accordion`, …). */
export function blockById(id: string) {
  return BLOCKS.find((b) => b.meta.id === id);
}
