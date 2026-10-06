# 8. Pair devices with a one-time code; keep SHEAF_TOKEN for admin

- Status: accepted
- Date: 2026-10-05

## Context

Every phone authenticates with the same `SHEAF_TOKEN`, typed or pasted by hand on the
connect screen. That is the worst step of onboarding, and it means one lost phone
forces rotating the token on every device. Nothing records which device sent a
document.

## Decision

- The web app (admin token) creates a **pairing code**: 128 bits, single use, valid
  for 5 minutes, stored only as its SHA-256. It shows a QR code encoding
  `sheaf://pair?server=<url>&code=<code>`.
- The phone scans it and calls `POST /v1/pair {code, deviceName}`. The server returns
  a **device token** (256 bits) once, and stores only its SHA-256 in `devices`.
- Device tokens may upload, read and patch documents. They cannot create pairing
  codes, list or revoke devices, or read `/metrics`.
- Revocation sets `revoked_at`; the next request returns 401 with
  `error: device_revoked`, which the app shows as such rather than as a network error.
- `SHEAF_TOKEN` remains, as the admin/bootstrap credential, and still works for
  uploads so existing installs keep working.
- Documents record the `device_id` that first stored them.

## Consequences

Onboarding becomes "scan this"; one device can be removed without touching others;
"which phone sent this" is answerable. Costs: a new table, a QR scanner on the
connect screen (expo-camera already does barcodes), and one more class of 401 for the
engine to classify as `BLOCKED` rather than retryable.
