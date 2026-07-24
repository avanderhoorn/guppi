/** Shared helpers that do not yet warrant a dedicated subsystem module. */

/** Removes HTML comments from one Markdown line while tracking multiline state. */
export function visibleMarkdown(
  rawLine: string,
  inComment: boolean
): { line: string; inComment: boolean } {
  let line = rawLine;
  if (inComment) {
    const closing = line.indexOf("-->");
    if (closing === -1) return { line: "", inComment: true };
    inComment = false;
    line = line.slice(closing + 3);
  }

  while (true) {
    const opening = line.indexOf("<!--");
    if (opening === -1) return { line, inComment };
    const closing = line.indexOf("-->", opening + 4);
    if (closing === -1) {
      return {
        line: line.slice(0, opening),
        inComment: true
      };
    }
    line = `${line.slice(0, opening)}${line.slice(closing + 3)}`;
  }
}

/** Returns Markdown lines that are outside HTML comments and fenced blocks. */
export function visibleMarkdownLines(contents: string): string[] {
  const lines: string[] = [];
  let offset = 0;
  let inComment = false;
  let fence: { marker: string; length: number } | null = null;

  while (offset < contents.length) {
    const newline = contents.indexOf("\n", offset);
    const end = newline === -1 ? contents.length : newline + 1;
    const rawLine = contents
      .slice(offset, end)
      .replace(/\n$/, "")
      .replace(/\r$/, "");
    offset = end;

    if (fence) {
      const closing = rawLine.match(/^\s{0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const visible = visibleMarkdown(rawLine, inComment);
    inComment = visible.inComment;
    const opening = visible.line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = {
        marker: opening[1][0],
        length: opening[1].length
      };
      continue;
    }
    lines.push(visible.line);
  }
  return lines;
}
