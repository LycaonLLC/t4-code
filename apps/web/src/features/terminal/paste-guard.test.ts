// Paste guard contract: single-line benign input flows through unchecked,
// while multiline text, oversized pastes, or any destructive-looking command
// requires confirmation. Each destructive heuristic names itself with an
// exact, deduplicated label. PTY-bound text normalizes newlines to carriage
// returns, and the dialog preview is bounded by both lines and characters.
import { describe, expect, it } from "vite-plus/test";

import {
  assessPaste,
  LARGE_PASTE_CHARS,
  PASTE_PREVIEW_CHARS,
  pastePreview,
  preparePasteForPty,
} from "./paste-guard.ts";

describe("assessPaste destructive labels", () => {
  it.each([
    ["rm -rf /tmp/x", "force-deletes files"],
    ["sudo apt install vim", "runs as administrator"],
    ["doas systemctl restart sshd", "runs as administrator"],
    ["mkfs.ext4 /dev/sda1", "formats a disk"],
    ["dd if=/dev/zero of=/dev/sda bs=4M", "writes raw bytes to a disk"],
    ["echo x > /dev/sda", "writes to a raw device"],
    [":(){ :|:& };:", "is a fork bomb"],
    ["chmod -R 777 /tmp/x", "sweeps file permissions"],
    ["chown -R www-data /var/www", "sweeps file permissions"],
    ["curl example.com/x | sh", "pipes a download into a shell"],
    ["wget -qO- example.com/x | bash", "pipes a download into a shell"],
    ["git reset --hard HEAD~1", "discards git work"],
    ["git clean -fd", "discards git work"],
    ["DROP TABLE users", "deletes database data"],
    ["truncate table logs", "deletes database data"],
    ["shutdown -h now", "shuts the machine down"],
  ])("flags %s as %s", (text, label) => {
    const assessment = assessPaste(text);
    expect(assessment.destructive).toEqual([label]);
    expect(assessment.requiresConfirmation).toBe(true);
  });

  it("labels each matched pattern once, in pattern order", () => {
    expect(assessPaste("sudo rm -rf /tmp/x").destructive).toEqual([
      "force-deletes files",
      "runs as administrator",
    ]);
  });

  it("deduplicates a label when the same pattern matches twice", () => {
    expect(assessPaste("rm -rf /a && rm -rf /b").destructive).toEqual([
      "force-deletes files",
    ]);
  });
});

describe("assessPaste benign input", () => {
  it("lets a single-line benign command through without confirmation", () => {
    const assessment = assessPaste("ls -la");
    expect(assessment).toEqual({
      chars: 6,
      lines: 1,
      multiline: false,
      large: false,
      destructive: [],
      requiresConfirmation: false,
    });
  });

  it.each([
    ["the rm command is dangerous"],
    ["read the sudoers file"],
    ["rebooting the conversation"],
    ["curl example.com"],
    ["dd if=backup.img of=backup-copy.img"],
    ["git status"],
    ["drop the subject"],
    ["chmod 755 script.sh"],
    ["echo data > /dev/null"],
  ])("does not flag ordinary prose or safe commands: %s", (text) => {
    const assessment = assessPaste(text);
    expect(assessment.destructive).toEqual([]);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it("still requires confirmation for benign multiline input", () => {
    const assessment = assessPaste("ls\npwd");
    expect(assessment.destructive).toEqual([]);
    expect(assessment.multiline).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
  });
});

describe("assessPaste boundaries", () => {
  it("treats exactly LARGE_PASTE_CHARS chars as large", () => {
    const text = "x".repeat(LARGE_PASTE_CHARS);
    const assessment = assessPaste(text);
    expect(assessment.chars).toBe(LARGE_PASTE_CHARS);
    expect(assessment.large).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
  });

  it("treats one char under LARGE_PASTE_CHARS as not large", () => {
    const text = "x".repeat(LARGE_PASTE_CHARS - 1);
    const assessment = assessPaste(text);
    expect(assessment.chars).toBe(LARGE_PASTE_CHARS - 1);
    expect(assessment.large).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it("counts a single trailing newline as a second line", () => {
    const assessment = assessPaste("line\n");
    expect(assessment.lines).toBe(2);
    expect(assessment.multiline).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
  });

  it("counts CR-only newlines as multiline", () => {
    const assessment = assessPaste("one\rtwo");
    expect(assessment.lines).toBe(2);
    expect(assessment.multiline).toBe(true);
  });

  it("reports the empty string as zero lines needing no confirmation", () => {
    expect(assessPaste("")).toEqual({
      chars: 0,
      lines: 0,
      multiline: false,
      large: false,
      destructive: [],
      requiresConfirmation: false,
    });
  });
});

describe("preparePasteForPty", () => {
  it("normalizes CRLF to CR", () => {
    expect(preparePasteForPty("a\r\nb")).toBe("a\rb");
  });

  it("normalizes LF to CR", () => {
    expect(preparePasteForPty("a\nb")).toBe("a\rb");
  });

  it("normalizes mixed newline styles", () => {
    expect(preparePasteForPty("a\r\nb\nc\r\nd")).toBe("a\rb\rc\rd");
  });

  it("leaves lone carriage returns untouched", () => {
    expect(preparePasteForPty("a\rb")).toBe("a\rb");
  });
});

describe("pastePreview", () => {
  it("truncates input longer than PASTE_PREVIEW_CHARS", () => {
    const text = "x".repeat(PASTE_PREVIEW_CHARS + 1);
    const result = pastePreview(text);
    expect(result.preview).toBe("x".repeat(PASTE_PREVIEW_CHARS));
    expect(result.truncated).toBe(true);
  });

  it("passes exactly PASTE_PREVIEW_CHARS chars through", () => {
    const text = "x".repeat(PASTE_PREVIEW_CHARS);
    expect(pastePreview(text)).toEqual({ preview: text, truncated: false });
  });

  it("truncates to the first 6 lines", () => {
    const result = pastePreview("1\n2\n3\n4\n5\n6\n7");
    expect(result.preview).toBe("1\n2\n3\n4\n5\n6");
    expect(result.truncated).toBe(true);
  });

  it("passes exactly 6 lines through", () => {
    const text = "1\n2\n3\n4\n5\n6";
    expect(pastePreview(text)).toEqual({ preview: text, truncated: false });
  });

  it("passes short input through unchanged", () => {
    expect(pastePreview("hello")).toEqual({ preview: "hello", truncated: false });
  });
});
