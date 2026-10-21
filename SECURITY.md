# Security policy

## Supported versions

| Version | Security fixes |
|---|---|
| latest `main` | yes |
| anything else | no |

## Reporting a vulnerability

Please do not post vulnerabilities in public issues, pull requests or discussions. Use **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting).

It helps if you include:

- the affected files or paths and the version (commit)
- steps to reproduce (a minimal example)
- the expected impact (privilege escalation, information disclosure, denial of service, etc.)

This is a PoC maintained by one person, so no response deadline can be promised. Confirmed reports are credited in the fixing commit (let us know if you prefer not to be named).

## Out of scope

- Behavior described in [README → Limitations](README.md#limitations) (removed participants rejoining with a refresh token, host controls not being enforced, etc.)
- Problems caused by a misconfigured `.env` (for example `MEETFLOW_ENV=development` in production)
- Vulnerabilities in the components themselves (LiveKit, Caddy, Valkey, etc.) — please report those to the respective projects
