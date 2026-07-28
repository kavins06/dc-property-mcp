const SQL_IDENTIFIER = /^[a-z_][a-z0-9_.]*$/;
const JSON_KEY = /^[A-Z][A-Z0-9_]*$/;
const FOUR_DIGIT_NUMBER = /^[0-9]{4}(?:\.0+)?$/;

export function normalizeCamaYear(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!FOUR_DIGIT_NUMBER.test(text)) return null;
  const year = Number(text);
  if (!Number.isInteger(year) || year < 1600 || year > 2200) return null;
  return year;
}

export function safeCamaYearSql(jsonExpression, key) {
  if (!SQL_IDENTIFIER.test(jsonExpression) || !JSON_KEY.test(key)) {
    throw new Error("Unsafe CAMA year SQL expression.");
  }
  const value = `${jsonExpression}->>'${key}'`;
  return [
    "case",
    `      when ${value} ~ '^[0-9]{4}(?:\\.0+)?$'`,
    `       and (${value})::numeric between 1600 and 2200`,
    `        then (${value})::numeric::smallint`,
    "    end",
  ].join("\n");
}
