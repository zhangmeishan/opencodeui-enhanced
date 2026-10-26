# Project working agreement

- Make and verify changes in the source workspace using local tests and isolated mocks.
- Never run `system-server.sh`, deploy to `/opt/opencodeui`, recreate production containers, or restart production services unless the user has tested the relevant changes and explicitly authorized deployment afterward.
- A report that tests passed or a request for another source change is not deployment authorization.
- Do not access existing OpenCode services or system configuration for verification without explicit user authorization. Use local fixtures instead.
