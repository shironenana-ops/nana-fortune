import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ServerFoundationError } from "../http/errors";
import { serializeReadingJobMessage, type ReadingJobQueue } from "./readingJobQueue";
import type { PaidReadingMode } from "./readingJobTypes";

export type ReadingQueueConfig = { lightQueueUrl: string; deepQueueUrl: string };

function requiredQueueUrl(value: string | undefined): string {
  if (!value || value.length > 2048 || !/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\//u.test(value) || /[\r\n\0]/u.test(value)) {
    throw new ServerFoundationError("READING_QUEUE_NOT_CONFIGURED");
  }
  return value;
}

export function readReadingQueueConfig(env: NodeJS.ProcessEnv): ReadingQueueConfig {
  return {
    lightQueueUrl: requiredQueueUrl(env.READING_LIGHT_QUEUE_URL),
    deepQueueUrl: requiredQueueUrl(env.READING_DEEP_QUEUE_URL),
  };
}

type SqsSender = { send(command: SendMessageCommand): Promise<unknown> };

export class SqsReadingJobQueue implements ReadingJobQueue {
  constructor(private sender: SqsSender, private config: ReadingQueueConfig) {}

  async send(mode: PaidReadingMode, jobRef: string): Promise<void> {
    const queueUrl = mode === "light" ? this.config.lightQueueUrl : mode === "deep" ? this.config.deepQueueUrl : undefined;
    if (!queueUrl) throw new ServerFoundationError("READING_JOB_INCONSISTENT");
    try {
      await this.sender.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: serializeReadingJobMessage(jobRef),
      }));
    } catch (error) {
      throw new ServerFoundationError("READING_QUEUE_UNAVAILABLE", { cause: error });
    }
  }
}

export function createSqsReadingJobQueue(config: ReadingQueueConfig): ReadingJobQueue {
  return new SqsReadingJobQueue(new SQSClient({ maxAttempts: 1 }), config);
}
