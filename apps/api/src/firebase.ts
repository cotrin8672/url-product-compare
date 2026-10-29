import {
  createComparisonJobWorkerTrigger,
  createFirebaseApi,
} from "../../../packages/backend/src/firebase-bootstrap.js";

export const api = createFirebaseApi();
export const comparisonJobWorker = createComparisonJobWorkerTrigger();
