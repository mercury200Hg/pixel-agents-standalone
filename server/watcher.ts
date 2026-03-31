import { watch } from "chokidar";
import { statSync, readdirSync, openSync, readSync, closeSync, readFileSync, existsSync } from "fs";
import { join, basename, dirname, sep } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const ACTIVE_THRESHOLD_MS = 3_600_000; // 1 hour — keep idle agents visible longer
const POLL_INTERVAL_MS = 1000;

export interface WatchedFile {
  path: string;
  sessionId: string;
  projectName: string;
  offset: number;
  lineBuffer: string;
}

export class JsonlWatcher extends EventEmitter {
  private files = new Map<string, WatchedFile>();
  private watcher: ReturnType<typeof watch> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.scanForActiveFiles();

    this.watcher = watch(CLAUDE_PROJECTS_DIR, {
      ignoreInitial: true,
      depth: 3,
    });

    this.watcher.on("add", (filePath: string) => {
      if (filePath.endsWith(".jsonl")) {
        this.addFile(filePath);
      }
    });

    this.pollInterval = setInterval(() => this.pollFiles(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.watcher?.close();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private scanForActiveFiles(): void {
    try {
      const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = join(CLAUDE_PROJECTS_DIR, dir.name);
        this.scanDirRecursive(dirPath);
      }
    } catch {
      /* projects dir may not exist */
    }
  }

  private scanDirRecursive(dirPath: string, depth = 0): void {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          this.scanDirRecursive(fullPath, depth + 1);
        } else if (entry.name.endsWith(".jsonl")) {
          const stat = statSync(fullPath);
          if (Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS) {
            this.addFile(fullPath);
          }
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  private addFile(filePath: string): void {
    if (this.files.has(filePath)) return;

    const sessionId = basename(filePath, ".jsonl");
    // Walk up to find the project dir directly under CLAUDE_PROJECTS_DIR
    let projectDirName = basename(dirname(filePath));
    let cur = dirname(filePath);
    while (dirname(cur) !== CLAUDE_PROJECTS_DIR && cur !== dirname(cur)) {
      cur = dirname(cur);
      projectDirName = basename(cur);
    }

    // Try to extract agent name from the JSONL first line, then CLAUDE.md
    const projectName = this.extractNameFromJsonl(filePath) ||
      this.extractAgentName(projectDirName) ||
      projectDirName.split("-").filter(Boolean).pop() ||
      sessionId.slice(0, 8);

    const file: WatchedFile = {
      path: filePath,
      sessionId,
      projectName,
      offset: 0,
      lineBuffer: "",
    };

    this.files.set(filePath, file);
    this.emit("fileAdded", file);

    // Read existing content to catch up
    this.readNewLines(file);
  }

  /**
   * Read the first line of a JSONL transcript to extract the agent's display name.
   * Checks the "agentName" field and also looks for "You are **Name**" in the first message.
   */
  private extractNameFromJsonl(filePath: string): string | null {
    try {
      // Read just enough to get the first line
      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(4096);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const text = buf.toString("utf-8", 0, bytesRead);
      const firstLine = text.split("\n")[0];
      if (!firstLine) return null;

      const record = JSON.parse(firstLine);

      // Try to find display name like "You are **Pixel**" in message content
      const content = record.message?.content;
      const textContent = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.find((b: { type?: string; text?: string }) => b.type === "text")?.text || ""
          : "";
      const boldMatch = textContent.match(/You are \*\*(\w+)\*\*/);
      if (boldMatch) return boldMatch[1];

      // Fall back to agentName field (e.g. "frontend-agent" -> "frontend-agent")
      if (record.agentName) return record.agentName;

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve an encoded path like ["Users","mercury","Documents","quizfirst","quizfirst","workspace"]
   * back to a real filesystem path by greedily joining segments with dashes when a directory exists.
   * e.g. tries /Users -> exists, /Users/mercury -> exists, ... /quizfirst-workspace -> exists!
   */
  private resolveEncodedPath(segments: string[]): string | null {
    let current = sep; // start at root
    let i = 0;
    while (i < segments.length) {
      // Try joining remaining segments with dashes, longest match first
      let matched = false;
      for (let j = segments.length; j > i; j--) {
        const candidate = join(current, segments.slice(i, j).join("-"));
        try {
          const stat = statSync(candidate);
          if (stat.isDirectory()) {
            current = candidate;
            i = j;
            matched = true;
            break;
          }
        } catch { /* doesn't exist, try shorter */ }
      }
      if (!matched) return null;
    }
    return current;
  }

  /**
   * Decode the Claude projects dir name back to a real path and read CLAUDE.md
   * to extract the agent name from the first heading.
   * e.g. "-Users-alice-Documents-myproject" -> "/Users/alice/Documents/myproject"
   */
  private extractAgentName(projectDirName: string): string | null {
    try {
      // Decode the encoded dir name back to a real path.
      // e.g. "-Users-mercury-Documents-Projects-github-quizfirst-quizfirst-workspace"
      // Dashes are ambiguous (path sep vs literal dash in folder names).
      // Strategy: split on dashes, then greedily join segments to find existing directories.
      const segments = projectDirName.slice(1).split("-"); // drop leading dash
      const realPath = this.resolveEncodedPath(segments);
      if (!realPath) return null;
      const claudeMdPath = join(realPath, "CLAUDE.md");
      if (!existsSync(claudeMdPath)) return null;

      const content = readFileSync(claudeMdPath, "utf-8");
      // Look for a name in parentheses in the first heading, e.g. "# ... Agent (Canvas)"
      const parenMatch = content.match(/^#[^#].*\(([^)]+)\)/m);
      if (parenMatch) return parenMatch[1];

      // Otherwise try to extract the role, e.g. "# quizfirst-workspace — Engineering Manager Agent"
      const dashMatch = content.match(/^#[^#].*?—\s*(.+?)(?:\s+Agent)?\s*$/m);
      if (dashMatch) return dashMatch[1];

      return null;
    } catch {
      return null;
    }
  }

  private pollFiles(): void {
    for (const [path, file] of this.files) {
      try {
        const stat = statSync(path);
        if (stat.size > file.offset) {
          this.readNewLines(file);
        }
        // Remove stale files
        if (Date.now() - stat.mtimeMs > ACTIVE_THRESHOLD_MS) {
          this.files.delete(path);
          this.emit("fileRemoved", file);
        }
      } catch {
        this.files.delete(path);
        this.emit("fileRemoved", file);
      }
    }
  }

  private readNewLines(file: WatchedFile): void {
    try {
      const stat = statSync(file.path);
      if (stat.size <= file.offset) return;

      const buf = Buffer.alloc(stat.size - file.offset);
      const fd = openSync(file.path, "r");
      readSync(fd, buf, 0, buf.length, file.offset);
      closeSync(fd);

      file.offset = stat.size;
      const text = file.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");

      // Last element is incomplete line (buffer it)
      file.lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.emit("line", file, line);
        }
      }
    } catch {
      /* file may have been deleted */
    }
  }

  getActiveFiles(): WatchedFile[] {
    return Array.from(this.files.values());
  }
}
