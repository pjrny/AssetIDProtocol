import { createHandler } from "./index";
import { backfillVisualRoute, extractAndStore, visualIdentifyRoute } from "./visual-recognition";

/** Phase 2 entry point: Phase 1 handler + optional visual recognition. */
export default createHandler({
  extraRoutes: [visualIdentifyRoute, backfillVisualRoute],
  afterRegister: (env) => (assetId, file) => extractAndStore(assetId, file, env),
});
