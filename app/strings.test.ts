import { describe, expect, it } from "vitest";
import { strings } from "./strings";

describe("strings", () => {
  it("exposes the expected top-level keys", () => {
    expect(strings).toHaveProperty("app.title");
    expect(strings).toHaveProperty("buttons.start");
    expect(strings).toHaveProperty("status.done");
  });

  it("formats badge counts via functions", () => {
    expect(strings.badges.moreFiles(3)).toContain("3");
  });
});

// Pure helper duplicated for testability (page.tsx keeps its private copy).
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

describe("basename", () => {
  it("extracts the trailing segment of a posix path", () => {
    expect(basename("/tmp/song.ncm")).toBe("song.ncm");
  });

  it("extracts the trailing segment of a windows path", () => {
    expect(basename("C:\\Users\\me\\song.ncm")).toBe("song.ncm");
  });

  it("returns the input when no separators are present", () => {
    expect(basename("song.ncm")).toBe("song.ncm");
  });

  it("handles empty input by returning it as-is", () => {
    expect(basename("")).toBe("");
  });
});