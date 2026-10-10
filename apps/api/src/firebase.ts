import {
  createComparisonJobWorkerTrigger,
  createFirebaseApi,
} from "../../../packages/backend/src/bootstrap.js";

export const api = createFirebaseApi();
export const comparisonJobWorker = createComparisonJobWorkerTrigger();
