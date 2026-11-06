export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  if (tools.includes("subagent")) {
    instructions.push(
      "- If a task can be split up into independent subtasks and subagent resources are available, do so and invoke subagents to help. Partition by disjoint module/directory scopes (<10% file overlap, <=5 turns / <=12-15 tool calls per child returning verbatim file:line snippets so Root never re-reads child files); read shared hubs or tightly coupled slices (<=10 files) directly in Root and delegate disjoint branches.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
