import type { IsoDateTime } from "../domain/shared/time.js";

/** Source of wall-clock time; adapters must return UTC values. */
export interface Clock {
  now(): IsoDateTime;
}
