import {
  runShironeEngine,
  type ShironeEngineInput,
  type ShironeEngineResult,
} from "../lib/shironeEngine";

export type ShironeServerEngineInput = Omit<ShironeEngineInput, "today"> & {
  today: string;
};

/**
 * Node.js server entry point for the shared Shirone engine.
 * Authentication, authorization, persistence and HTTP concerns belong to
 * future adapters and must not be added here.
 */
export function runShironeEngineOnServer(
  input: ShironeServerEngineInput,
): ShironeEngineResult {
  return runShironeEngine(input);
}

export { runShironeEngine } from "../lib/shironeEngine";
export type {
  ShironeEngineInput,
  ShironeEngineResult,
  ShironePlan,
} from "../lib/shironeEngine";
