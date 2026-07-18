import { ProductError } from "./errors.js";

export const PRODUCT_NAME_MAX_LENGTH = 160;

export function requireNonEmptyString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductError(`${field} is required`);
  }
  const normalized = value.trim();
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new ProductError(`${field} must be ${maxLength} characters or less`);
  }
  return normalized;
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
