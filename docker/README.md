# A Paperless-ngx of your own

Sheaf has no backend. It sends documents straight to a Paperless-ngx server that
_you_ run — which means to develop or test it, you need one running somewhere.

That is what this is: the same self-hosted software a Sheaf user installs on a NAS
or a Raspberry Pi, started on your own machine.

```bash
docker compose -f docker/compose.paperless.yml up -d
open http://localhost:8000            # admin / admin
```

## Getting an API token

Either from the web UI (profile → API token), or straight from the API:

```bash
curl -s -X POST http://localhost:8000/api/token/ \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

## Pointing the app at it

| Running on       | Server URL                        |
| ---------------- | --------------------------------- |
| iOS simulator    | `http://localhost:8000`           |
| Android emulator | `http://10.0.2.2:8000`            |
| A real phone     | `http://<your-mac's-LAN-IP>:8000` |

A real device needs to be on the same network as your machine, and Sheaf treats a
plain-HTTP address as fine for a local server — a certificate failure on a public
one is a blocking error by design, never something it silently works around.

## Tearing it down

```bash
docker compose -f docker/compose.paperless.yml down -v   # -v also drops the documents
```
