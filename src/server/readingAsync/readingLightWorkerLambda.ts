import { createReadingWorkerLambda } from "./readingWorkerLambdaFactory";

export const handler = createReadingWorkerLambda("light");
