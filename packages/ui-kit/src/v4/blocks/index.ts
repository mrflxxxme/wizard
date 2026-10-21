// Block library of wave V5 (V5-01; grill-11, grill-12 (2)): directions «Мастерская» and «Ночной продукт» cut from
// the accepted bar sites. The director (V5-03) reads BLOCKS[].spec, fills slots, checks them with contentErrors and
// the bans, then renders the components.
export {
  AI_PHRASES,
  aiTextErrors,
  blockContrastPairs,
  contentStrings,
  paletteBanErrors,
  templateMarkupErrors,
} from "./bans.js";
export { BLOCKS, BlockById, block, blocksOf, contentErrors } from "./catalog.js";
export { BLOCKS_CSS, directionCss, directionFonts } from "./css.js";
export { DIRECTIONS, MASTERSKAYA_DS, NOCHNOY_DS } from "./directions.js";
export { type Photo, rub, stillFrame, useStill } from "./kit.js";
export {
  MFooter,
  type MFooterContent,
  MHeader,
  type MHeaderContent,
  MHero,
  type MHeroContent,
  MLocations,
  type MLocationsContent,
  MMenu,
  type MMenuContent,
  MMoment,
  type MMomentContent,
  MOrder,
  type MOrderContent,
  MReviews,
  type MReviewsContent,
} from "./masterskaya.js";
export {
  type CarModel,
  NBooking,
  type NBookingContent,
  NContacts,
  type NContactsContent,
  NFooter,
  type NFooterContent,
  NHeader,
  type NHeaderContent,
  NHero,
  type NHeroContent,
  NPrices,
  type NPricesContent,
  NReviews,
  type NReviewsContent,
  NStatus,
  type NStatusContent,
  NSteps,
  type NStepsContent,
} from "./nochnoy.js";
export type * from "./types.js";
