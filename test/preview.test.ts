import { describe, expect, test } from "vitest"
import { fileLabel, pathFromTabKey, pickPreviewedFile, previewedFilePath, type TabCandidate } from "../src/preview"

describe("pathFromTabKey", () => {
  test("reads a workspace-relative path from a file tab key", () => {
    expect(pathFromTabKey("file://docs/notes.md")).toBe("docs/notes.md")
  })

  test("decodes percent-escaped segments but keeps separators", () => {
    expect(pathFromTabKey("file://src/my%20app/main%2Bcode.ts")).toBe("src/my app/main+code.ts")
  })

  test("keeps absolute paths outside the workspace", () => {
    expect(pathFromTabKey("file:///etc/hosts")).toBe("/etc/hosts")
  })

  test("rejects non-file tabs and empty keys", () => {
    expect(pathFromTabKey("browser:tab_1")).toBeUndefined()
    expect(pathFromTabKey("file:open")).toBeUndefined()
    expect(pathFromTabKey("file://")).toBeUndefined()
    expect(pathFromTabKey("")).toBeUndefined()
    expect(pathFromTabKey(null)).toBeUndefined()
  })

  test("survives malformed percent escapes", () => {
    expect(pathFromTabKey("file://a%zz/b")).toBe("a%zz/b")
  })
})

describe("pickPreviewedFile", () => {
  const tab = (value: string, selected: boolean): TabCandidate => ({ value, selected })

  test("returns the selected file tab", () => {
    expect(pickPreviewedFile([tab("file://a.md", false), tab("file://b.md", true)])).toBe("b.md")
  })

  test("ignores selected tabs that are not files", () => {
    expect(pickPreviewedFile([tab("browser:tab_1", true), tab("file://b.md", false)])).toBeUndefined()
  })

  test("takes the first selected file when several look selected", () => {
    expect(pickPreviewedFile([tab("file://x.md", true), tab("file://y.md", true)])).toBe("x.md")
  })

  test("returns undefined for no candidates", () => {
    expect(pickPreviewedFile([])).toBeUndefined()
  })
})

describe("previewedFilePath", () => {
  test("is undefined without a document", () => {
    expect(previewedFilePath()).toBeUndefined()
  })
})

describe("fileLabel", () => {
  test("takes the last segment", () => {
    expect(fileLabel("docs/deep/notes.md")).toBe("notes.md")
    expect(fileLabel("notes.md")).toBe("notes.md")
    expect(fileLabel("/etc/hosts")).toBe("hosts")
  })
})
