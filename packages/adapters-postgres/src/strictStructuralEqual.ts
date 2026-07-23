import { isDeepStrictEqual } from "node:util";

export function strictStructuralEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
