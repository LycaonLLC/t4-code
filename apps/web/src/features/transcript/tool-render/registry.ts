/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic.tsx";
import { askRenderer } from "./tools/ask.tsx";
import { astEditRenderer } from "./tools/ast-edit.tsx";
import { astGrepRenderer } from "./tools/ast-grep.tsx";
import { bashRenderer } from "./tools/bash.tsx";
import { browserRenderer } from "./tools/browser.tsx";
import { debugRenderer } from "./tools/debug.tsx";
import { editRenderer } from "./tools/edit.tsx";
import { evalRenderer } from "./tools/eval.tsx";
import { fetchRenderer } from "./tools/fetch.tsx";
import { generateImageRenderer } from "./tools/generate-image.tsx";
import { githubRenderer } from "./tools/github.tsx";
import { globRenderer } from "./tools/glob.tsx";
import { goalRenderer } from "./tools/goal.tsx";
import { grepRenderer } from "./tools/grep.tsx";
import { inspectImageRenderer } from "./tools/inspect-image.tsx";
import { hubRenderer } from "./tools/hub.tsx";
import { ircRenderer } from "./tools/irc.tsx";
import { jobRenderer } from "./tools/job.tsx";
import { lspRenderer } from "./tools/lsp.tsx";
import { recallRenderer } from "./tools/memory-recall.tsx";
import { reflectRenderer } from "./tools/memory-reflect.tsx";
import { retainRenderer } from "./tools/memory-retain.tsx";
import { readRenderer } from "./tools/read.tsx";
import { proposeRenderer } from "./tools/propose.tsx";
import { reportFindingRenderer } from "./tools/report-finding.tsx";
import { reportToolIssueRenderer } from "./tools/report-tool-issue.tsx";
import { resolveRenderer } from "./tools/resolve.tsx";
import { searchBm25Renderer } from "./tools/search-bm25.tsx";
import { sshRenderer } from "./tools/ssh.tsx";
import { taskRenderer } from "./tools/task.tsx";
import { todoRenderer } from "./tools/todo.tsx";
import { webSearchRenderer } from "./tools/web-search.tsx";
import { writeRenderer } from "./tools/write.tsx";
import { yieldRenderer } from "./tools/yield.tsx";
import type { ToolRenderer } from "./types.ts";

const RENDERERS: Record<string, ToolRenderer> = {
  ask: askRenderer,
  ast_edit: astEditRenderer,
  ast_grep: astGrepRenderer,
  bash: bashRenderer,
  browser: browserRenderer,
  puppeteer: browserRenderer,
  debug: debugRenderer,
  edit: editRenderer,
  apply_patch: editRenderer,
  eval: evalRenderer,
  js: evalRenderer,
  python: evalRenderer,
  notebook: evalRenderer,
  fetch: fetchRenderer,
  glob: globRenderer,
  find: globRenderer,
  generate_image: generateImageRenderer,
  github: githubRenderer,
  goal: goalRenderer,
  inspect_image: inspectImageRenderer,
  hub: hubRenderer,
  irc: ircRenderer,
  job: jobRenderer,
  await: jobRenderer,
  poll: jobRenderer,
  cancel_job: jobRenderer,
  lsp: lspRenderer,
  recall: recallRenderer,
  reflect: reflectRenderer,
  retain: retainRenderer,
  read: readRenderer,
  propose: proposeRenderer,
  report_finding: reportFindingRenderer,
  report_issue: reportToolIssueRenderer,
  report_tool_issue: reportToolIssueRenderer,
  reject: resolveRenderer,
  resolve: resolveRenderer,
  grep: grepRenderer,
  search: grepRenderer,
  search_tool_bm25: searchBm25Renderer,
  ssh: sshRenderer,
  task: taskRenderer,
  subagent: taskRenderer,
  todo: todoRenderer,
  web_search: webSearchRenderer,
  write: writeRenderer,
  yield: yieldRenderer,
};

function rendererKey(name: string): string {
  return name.trim().toLowerCase();
}

export function hasToolRenderer(name: string): boolean {
  return Object.hasOwn(RENDERERS, rendererKey(name));
}

export function resolveToolRenderer(name: string): ToolRenderer {
  const key = rendererKey(name);
  return Object.hasOwn(RENDERERS, key) ? RENDERERS[key]! : genericRenderer;
}
