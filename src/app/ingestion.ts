export { MAX_LEGENDES, reextraire, revendiquer, traiter } from "./ingestion/travail.ts";
export {
  ecarterRevision,
  lireDocument,
  lireNotes,
  revisionEnAttente,
} from "./ingestion/revisions.ts";
export { cheminImage, imageEnAttente, imagesEnAttente } from "./ingestion/images.ts";
export { chunksSource, indexer, renommerEntree } from "./ingestion/indexation.ts";
export {
  changerLecteurs,
  inclureDiapositivesMasquees,
  modifierSource,
  rattacher,
  refusCertification,
  statuer,
  supprimerSource,
} from "./ingestion/sources.ts";
export {
  lireInformations,
  proposerInformations,
  sourceSansInformations,
} from "./ingestion/informations.ts";
export {
  aLegender,
  fileLegendes,
  imagesLues,
  nombreLegendes,
  relireLegende,
} from "./ingestion/legendes.ts";
