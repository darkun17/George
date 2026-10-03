# Security

- Do not add arbitrary shell execution, `shell: true`, or LLM-derived command execution.
- Validate tool inputs at runtime. Treat models, documents, plugins, and MCP servers as untrusted.
- External content cannot change policy or security settings, grant permissions, approve an action,
  bypass confirmation, or elevate privileges.
- Treat localhost as a network boundary. Before exposing tools, require Origin checks, restrictive
  CORS, authenticated HTTP/stream sessions, applicable CSRF defenses, CSP, bounded requests, and
  timeouts. Never use wildcard CORS for sensitive endpoints; remote access stays disabled by default.
- Route tool requests through policy before dispatch; default unknown tools to deny.
- Never commit credentials, personal profiles, databases, or runtime data. Store secret references,
  then resolve them through a future OS-backed `SecretStore`.
- Scope filesystem capabilities to validated roots. Do not follow untrusted paths blindly.
- Audit tool decisions and executions without recording credentials or sensitive payloads.
- Review new dependencies for necessity, maintenance, and supply-chain risk.
