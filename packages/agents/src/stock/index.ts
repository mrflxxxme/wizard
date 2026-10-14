// @wizard/agents/stock (V4-10, D79 (6)): the semantic photo library — niche catalog, shards with SigLIP embeddings,
// search by the meaning of a Russian query, backfill requests, the SigLIP encoders and the photo grade of a direction.

/** Niches CI fills, in priority order; shard slugs of requested niches. */
export {
  CATALOG,
  type CatalogNiche,
  catalogNiche,
  NICHE_TARGET,
  normalizeNicheText,
  requestSlug,
} from "./catalog.js";
/** One CSS filter for every photo of a site from the direction's treatment and accent. */
export { GRADED_PHOTOS, type PhotoGrade, photoGrade, photoGradeCss } from "./grade.js";
/** The photos of a site from the library: per-kind search, the vision pick, no repeats, backfill; the platform source. */
export {
  BACKFILL_MIN_LIBRARY,
  createSemanticSource,
  fitsPhotoSlot,
  type PhotoPicker,
  PICK_CANDIDATES,
  type PickAnswer,
  type PickInput,
  photoQueryText,
  SEMANTIC_TTL_MS,
  type SemanticPhotoSource,
  type SemanticPhotosResult,
  semanticPhotos,
  siteShards,
} from "./photos.js";
/** photo_pick: the vision model assigns the candidates to the slots (null on failure — rank order). */
export { modelPhotoPicker, PHOTO_PICK_CALL_TYPE, photoPickMessages, photoPickTool } from "./pick.js";
/** Shards, manifest and requests in the file storage; SemanticLibrary.search — candidates by cosine. */
export {
  type Candidate,
  decodeVectors,
  EMBED_DIM,
  encodeVectors,
  flagTextPhotos,
  GOOD_SCORE,
  hitOfEntry,
  type LibraryObjects,
  type LibraryPhotoEntry,
  loadSemanticLibrary,
  MAX_FLAGS,
  MAX_REQUESTS,
  type Manifest,
  MIN_GOOD,
  type NicheRequests,
  needsBackfill,
  normalize,
  type PhotoFlags,
  pick,
  type QuantizedVectors,
  quantize,
  readFlags,
  readManifest,
  readRequests,
  readShard,
  requestBackfill,
  SEMANTIC_MODEL,
  SEMANTIC_OBJECTS,
  SEMANTIC_VERSION,
  type SearchOptions,
  type SemanticEntry,
  SemanticLibrary,
  type Shard,
  sourceOf,
  storageObjects,
  vectorsChecksum,
  writeManifest,
  writeRequests,
  writeShard,
} from "./semantic.js";
/** SigLIP 2 towers over onnxruntime-node: pinned files, image input without sharp, a lazily loaded text encoder. */
export {
  ensureModelFiles,
  type ImageEmbedder,
  imageInput,
  lazyTextEncoder,
  loadImageEncoder,
  loadTextEncoder,
  localName,
  padTokens,
  type Rgba,
  SIGLIP,
  type SiglipFile,
  sha256,
  siglipUrl,
  TEXT_FILES,
  type TextEmbedder,
  textForModel,
  VISION_FILES,
} from "./siglip.js";
