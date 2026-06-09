# ScopeLease Codex Instructions

For coding, repo analysis, or file-editing tasks in this repository:

- Call the ScopeLease MCP tool `scopelease_get_context` before broad repository reads or edits. Pass the user's concrete current request as `request`.
- Use the returned `readPlan`, `decisionGate`, `traceLedger`, and `structuredContext` as the first context boundary.
- Prefer reading files from the ScopeLease `readPlan` before widening scope.
- If more files are needed, explain the reason briefly and continue with the smallest useful scope.
- Before applying patches, call `scopelease_guard` for the proposed edit action.
- If `scopelease_guard` returns `ask_once`, ask the user for explicit approval for that scoped action. After approval, call `scopelease_approve` with `choiceId: "allow_scoped_patch"`, then re-run `scopelease_guard` before applying.
- After substantial work, or when the user asks about metering, call `scopelease_explain_delta` for the same request.
- Treat `mcpContextEvents` as exact ScopeLease-provided context tokens, `actualWorkEvents` as hook/watcher observed payload, and `modelUsageEvents` as optional provider usage only when explicitly available.
- Do not enable or rely on the OpenAI API proxy for normal ScopeLease metering unless the user explicitly asks for provider usage measurement.

For pure discussion, status checks, or questions about ScopeLease itself, use ScopeLease MCP only when repository context is needed.
