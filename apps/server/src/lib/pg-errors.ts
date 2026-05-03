// PostgreSQL SQLSTATE codes used in error handling.
// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html

export const PG_ERROR_CODES = {
  UNIQUE_VIOLATION: "23505",
  DUPLICATE_TABLE: "42P07",
} as const;
