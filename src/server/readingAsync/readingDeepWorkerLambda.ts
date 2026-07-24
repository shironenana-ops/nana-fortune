import { createReadingWorkerLambda } from "./readingWorkerLambdaFactory";

export const handler = createReadingWorkerLambda("deep");
