import { isoDateTimeFromDate } from "../../domain/shared/time.js";
import type { Clock } from "../../ports/clock.js";

export class SystemClock implements Clock {
  now() {
    return isoDateTimeFromDate(new Date());
  }
}
