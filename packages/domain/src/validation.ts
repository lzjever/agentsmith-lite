import { ProductError } from "./errors.js";

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductError(`${field} is required`);
  }
  return value.trim();
}

export function requirePositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProductError(`${field} must be a positive integer`);
  }
  return value;
}

