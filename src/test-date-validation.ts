// test-date-validation.ts
import jsyaml from "js-yaml";

/**
 * Helper under test: accept Date objects, parseable strings, and numeric timestamps.
 */
function isValidDateValue(value: any): boolean {
  if (value instanceof Date) {
    return !isNaN(value.getTime());
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return !isNaN(d.getTime());
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return !isNaN(d.getTime());
  }
  return false;
}

/** Simple assertion helper */
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("OK:", msg);
  }
}

/** Test cases */
async function runTests() {
  // 1) YAML frontmatter that contains a plain date (js-yaml may parse to Date)
  const yaml1 = `---
created: 2026-05-28
edited: 2026-05-28T12:34:56Z
---`;
  const parsed1 = jsyaml.load(yaml1) as any;
  console.log("Parsed YAML 1:", parsed1);
  assert(parsed1.created instanceof Date, "js-yaml parsed '2026-05-28' into a Date object");
  assert(parsed1.edited instanceof Date, "js-yaml parsed ISO datetime into a Date object");
  assert(isValidDateValue(parsed1.created), "Date object from YAML is valid");
  assert(isValidDateValue(parsed1.edited), "Date object from YAML (ISO) is valid");

  // 2) String inputs
  assert(isValidDateValue("2026-05-28"), "String '2026-05-28' parses as valid date");
  assert(isValidDateValue("2026-05-28T00:00:00Z"), "ISO string parses as valid date");
  assert(!isValidDateValue("2026-13-01"), "Invalid month string is not a valid date");
  assert(!isValidDateValue("not-a-date"), "Nonsense string is not a valid date");

  // 3) Date object
  assert(isValidDateValue(new Date("2026-05-28")), "new Date('2026-05-28') is valid");

  // 4) Numeric timestamp
  const ts = Date.UTC(2026, 4, 28); // months are 0-based
  assert(isValidDateValue(ts), "Numeric timestamp (ms since epoch) is valid");

  // 5) Edge cases
  assert(!isValidDateValue(null), "null is not a valid date");
  assert(!isValidDateValue(undefined), "undefined is not a valid date");
  assert(!isValidDateValue({}), "object is not a valid date");

  console.log("\nAll tests completed. If any failed, process exit code will be non-zero.");
}

runTests().catch(err => {
  console.error("Test run failed:", err);
  process.exitCode = 2;
});
