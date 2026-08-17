import { b } from "../domain/b.js";
import type { Store } from "../ports/store.js";

export function run(store: Store): number {
  store.save();
  return b;
}
