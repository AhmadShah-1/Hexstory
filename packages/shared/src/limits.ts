/** Content limits shared by the editor (client-side hints) and the API (enforcement). */
export const LIMITS = {
  titleMin: 4,
  titleMax: 120,
  bodyMin: 40,
  bodyMax: 10_000,
  sourcesMin: 1,
  sourcesMax: 20,
  sourceTitleMax: 200,
  sourceUrlMax: 2_000,
  editSummaryMax: 200,
  imageCreditMax: 200,
  /** Maximum number of base-resolution cells one story may cover (~1.3M km²). */
  cellsMax: 5_000,
  chatMessageMax: 500,
  displayNameMin: 2,
  displayNameMax: 32,
  reportDetailsMax: 1_000,
  imageBytesMax: 6 * 1024 * 1024,
  imagesMax: 12,
  blocksMax: 400,
} as const;
