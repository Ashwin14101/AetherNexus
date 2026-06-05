# Matrix Dashboard — AI Skills & Rules

## Original Operational Rules

**Rule 1:** Always call `fetch_latest_logs` before responding to any prompt.
**Rule 2:** Always call `analyze_system_health` after fetching logs.
**Rule 3:** If CPU is above 90 output exactly `{"status": "CRITICAL", "color": "RED"}`.
**Rule 4:** If CPU is 90 or below output exactly `{"status": "STABLE", "color": "GREEN"}`.
**Rule 5:** Never guess or assume — always base the answer on real fetched data.

## Communication & Explanation Rules

**Rule 6:** After writing every file, explain the code in plain English section by section — not line by line, but block by block.
**Rule 7:** For every concept that is new or important (like `setInterval`, `stdio`, `deque`, MCP tools), give a one-paragraph real-world analogy so the user understands what it actually does, not just what it is called.
**Rule 8:** When explaining, assume the user understands basic programming logic but is new to Node.js and MCP — so never skip explaining why something is done, not just what it does.
**Rule 9:** Format every explanation like this: first the code block, then a "What this does" section, then a "Why we wrote it this way" section.
**Rule 10:** If there are multiple ways to do something, tell the user which way was chosen and why the other ways were worse for this project.
z