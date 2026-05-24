import { describe, expect, test } from "bun:test";
import {
  isPeerStatus,
  isTaskState,
  isValidSkillsInput,
  parseSkills,
  serializeSkills,
} from "./status.ts";

describe("isPeerStatus", () => {
  test("accepts every documented enum value", () => {
    expect(isPeerStatus("available")).toBe(true);
    expect(isPeerStatus("busy")).toBe(true);
    expect(isPeerStatus("away")).toBe(true);
  });

  test("rejects close-but-wrong inputs", () => {
    expect(isPeerStatus("AVAILABLE")).toBe(false);
    expect(isPeerStatus("BUSY")).toBe(false);
    expect(isPeerStatus(" available")).toBe(false);
    expect(isPeerStatus("available ")).toBe(false);
    expect(isPeerStatus("working")).toBe(false);
    expect(isPeerStatus("idle")).toBe(false);
    expect(isPeerStatus("")).toBe(false);
  });

  test("rejects non-string types", () => {
    expect(isPeerStatus(null)).toBe(false);
    expect(isPeerStatus(undefined)).toBe(false);
    expect(isPeerStatus(0)).toBe(false);
    expect(isPeerStatus(true)).toBe(false);
    expect(isPeerStatus({})).toBe(false);
    expect(isPeerStatus([])).toBe(false);
  });
});

describe("isTaskState", () => {
  test("accepts every documented enum value", () => {
    expect(isTaskState("working")).toBe(true);
    expect(isTaskState("completed")).toBe(true);
    expect(isTaskState("failed")).toBe(true);
    expect(isTaskState("canceled")).toBe(true);
  });

  test("rejects close-but-wrong inputs", () => {
    expect(isTaskState("WORKING")).toBe(false);
    expect(isTaskState("complete")).toBe(false);
    expect(isTaskState("completed ")).toBe(false);
    expect(isTaskState("done")).toBe(false);
    expect(isTaskState("cancelled")).toBe(false); // British spelling intentionally not accepted
    expect(isTaskState("")).toBe(false);
  });

  test("rejects non-string types", () => {
    expect(isTaskState(null)).toBe(false);
    expect(isTaskState(undefined)).toBe(false);
    expect(isTaskState(1)).toBe(false);
    expect(isTaskState({ state: "working" })).toBe(false);
  });
});

describe("serializeSkills + parseSkills round-trip", () => {
  test("null round-trips as null (no skills declared)", () => {
    expect(serializeSkills(null)).toBe(null);
    expect(parseSkills(null)).toBe(null);
  });

  test("undefined input is treated as null", () => {
    expect(serializeSkills(undefined)).toBe(null);
    expect(parseSkills(undefined)).toBe(null);
  });

  test("empty array round-trips as empty array (declared zero skills)", () => {
    const serialized = serializeSkills([]);
    expect(serialized).toBe("[]");
    expect(parseSkills(serialized)).toEqual([]);
  });

  test("single-element array round-trips", () => {
    const serialized = serializeSkills(["rust"]);
    expect(serialized).toBe('["rust"]');
    expect(parseSkills(serialized)).toEqual(["rust"]);
  });

  test("multi-element array round-trips and preserves order", () => {
    const skills = ["rust", "sql", "frontend"];
    expect(parseSkills(serializeSkills(skills))).toEqual(skills);
  });

  test("strings with special chars round-trip safely", () => {
    const skills = ['c++', 'react-native', 'co"de'];
    expect(parseSkills(serializeSkills(skills))).toEqual(skills);
  });
});

describe("serializeSkills rejects bad input", () => {
  test("non-array → null", () => {
    expect(serializeSkills("rust" as unknown as string[])).toBe(null);
    expect(serializeSkills(42 as unknown as string[])).toBe(null);
    expect(serializeSkills({ 0: "rust" } as unknown as string[])).toBe(null);
  });

  test("array with non-string elements → null", () => {
    expect(serializeSkills([1, 2] as unknown as string[])).toBe(null);
    expect(serializeSkills(["rust", null] as unknown as string[])).toBe(null);
    expect(serializeSkills(["rust", { name: "sql" }] as unknown as string[])).toBe(null);
  });
});

describe("parseSkills handles corrupt or unexpected DB rows", () => {
  test("malformed JSON → null (defensive — broker shouldn't crash)", () => {
    expect(parseSkills("not json")).toBe(null);
    expect(parseSkills("[unclosed")).toBe(null);
    expect(parseSkills("{")).toBe(null);
  });

  test("parsed-but-not-an-array → null", () => {
    expect(parseSkills('"rust"')).toBe(null);
    expect(parseSkills("42")).toBe(null);
    expect(parseSkills('{"skill":"rust"}')).toBe(null);
  });

  test("array with non-string element → null", () => {
    expect(parseSkills('["rust",1]')).toBe(null);
    expect(parseSkills('[null]')).toBe(null);
  });
});

describe("isValidSkillsInput", () => {
  test("accepts null and string arrays", () => {
    expect(isValidSkillsInput(null)).toBe(true);
    expect(isValidSkillsInput([])).toBe(true);
    expect(isValidSkillsInput(["rust"])).toBe(true);
    expect(isValidSkillsInput(["rust", "sql"])).toBe(true);
  });

  test("rejects bare strings, undefined, numbers, objects", () => {
    expect(isValidSkillsInput(undefined)).toBe(false);
    expect(isValidSkillsInput("rust")).toBe(false);
    expect(isValidSkillsInput(42)).toBe(false);
    expect(isValidSkillsInput({})).toBe(false);
  });

  test("rejects arrays with non-string elements", () => {
    expect(isValidSkillsInput([1])).toBe(false);
    expect(isValidSkillsInput(["rust", 1])).toBe(false);
    expect(isValidSkillsInput([null])).toBe(false);
  });
});
