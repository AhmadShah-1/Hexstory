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
  displayNameMin: 2,
  displayNameMax: 32,
  reportDetailsMax: 1_000,
  imageBytesMax: 6 * 1024 * 1024,
  imagesMax: 12,
  blocksMax: 400,
  /** Stored size of one version's content (text, formatting, links, image references), UTF-8 bytes. */
  contentBytesMax: 64 * 1024,
  /** The short summary shown before the full account. */
  summaryMin: 20,
  summaryMax: 300,
  categoriesMin: 1,
  categoriesMax: 3,
  placeNameMax: 120,
  peopleMax: 20,
  personNameMin: 2,
  personNameMax: 80,
  /** Connections to other stories in one version. */
  linksMax: 20,
  developmentTitleMin: 4,
  developmentTitleMax: 160,
  developmentBodyMax: 2_000,
  correctionQuoteMin: 8,
  correctionQuoteMax: 500,
  correctionProposalMin: 10,
  correctionProposalMax: 2_000,
  correctionNoteMax: 1_000,
  collectionTitleMin: 4,
  collectionTitleMax: 120,
  collectionDescriptionMin: 20,
  collectionDescriptionMax: 2_000,
  collectionNoteMax: 300,
  /** Stories hand-picked into one collection. */
  collectionItemsMax: 200,
  /** Base cells a place collection's area may cover (~15M km², a continent). */
  collectionCellsMax: 60_000,
  /** Stories one search or list request returns per page. */
  pageSize: 30,
} as const;
