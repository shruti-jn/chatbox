# Linear Task Verification Rule

- For any Linear task, all assertion verification must be completed end to end in a real browser session using actual API keys.
- Do not rely on mocked flows, simulated credentials, prompt injection, or context injection during Linear-task verification.
- Each verification run must capture screenshots of the relevant browser states.
- Each verification run must also produce a GIF of the end-to-end flow and upload that GIF to the related Linear issue.
- Codex should fix all issues and all gaps it finds, rather than stopping at identification alone.
