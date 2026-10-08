# Test fixtures

`v0.2-ingest.db` is a server database exactly as the server left it before
connectors existed (main at `b8e5f06`): five documents, one untouched and four in
each forwarding state. Tests copy it before opening it, so migrations never touch
the committed file. Rebuild it only from that older code, never from current code,
or it stops testing the upgrade.
