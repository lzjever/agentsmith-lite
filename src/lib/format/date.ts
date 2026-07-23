type DateValue = string | number | Date;

const localDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const localDateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const localTimeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function date(value: DateValue): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatLocalDate(value: DateValue): string {
  return localDateFormatter.format(date(value));
}

export function formatLocalDateTime(value: DateValue): string {
  return localDateTimeFormatter.format(date(value));
}

export function formatLocalTime(value: DateValue): string {
  return localTimeFormatter.format(date(value));
}
