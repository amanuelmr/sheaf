import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { pairingUri, type DeviceSummary, type PairingCodeResponse } from '@sheaf/protocol';
import type { Api } from '../api';
import { when } from '../format';

/**
 * Phones that may use this server (ADR 0008). "Pair a phone" shows a QR code the
 * phone's camera opens straight into Sheaf, and the same code as text to type.
 */
export function Devices({ api, serverUrl }: { api: Api; serverUrl: string }) {
  const [devices, setDevices] = useState<readonly DeviceSummary[] | null>(null);
  const [pairing, setPairing] = useState<
    (PairingCodeResponse & { qr: string; knownIds: ReadonlySet<string> }) | null
  >(null);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.devices();
    if (result.ok) setDevices(result.value.devices);
    else setError(result.message);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is showing: tick the countdown, and notice the phone appear.
  useEffect(() => {
    if (pairing === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1_000);
    return () => clearInterval(timer);
  }, [pairing, load]);

  const startPairing = async () => {
    setError(null);
    const result = await api.createPairingCode();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const qr = await QRCode.toDataURL(pairingUri(serverUrl, result.value.code), {
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
    });
    setPairing({ ...result.value, qr, knownIds: new Set((devices ?? []).map((d) => d.id)) });
  };

  const revoke = async (id: string) => {
    const result = await api.revoke(id);
    setConfirming(null);
    if (!result.ok) setError(result.message);
    await load();
  };

  const secondsLeft =
    pairing === null ? 0 : Math.max(0, Math.round((pairing.expiresAt - now) / 1000));
  // A code works once: when a phone that was not here before appears, it was used.
  const justPaired =
    pairing === null ? undefined : (devices ?? []).find((d) => !pairing.knownIds.has(d.id));

  return (
    <>
      <h1>Phones</h1>
      {error === null ? null : <p className="error">{error}</p>}

      <div className="card">
        {justPaired !== undefined ? (
          <>
            <p>
              <span className="badge ok">✓</span> {justPaired.name} is paired and can scan into this
              server.
            </p>
            <button className="secondary" onClick={() => setPairing(null)}>
              Done
            </button>
          </>
        ) : pairing === null || secondsLeft === 0 ? (
          <>
            <p>
              Pair a phone to let it scan into this server. Each phone gets its own key, which you
              can take back here at any time.
            </p>
            <button onClick={() => void startPairing()}>Pair a phone</button>
          </>
        ) : (
          <div className="pairing">
            <img
              src={pairing.qr}
              alt="Pairing code: scan it with the phone's camera"
              width={240}
              height={240}
            />
            <div>
              <p>Scan this with the phone’s camera, or open Sheaf and tap “Scan pairing code”.</p>
              <p className="muted">Or type the code:</p>
              <p className="code">{pairing.code}</p>
              <p className="muted">
                Works once, for {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, '0')} more.
              </p>
              <button className="secondary" onClick={() => setPairing(null)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {devices === null ? <p className="muted">Loading…</p> : null}
      {devices !== null && devices.length === 0 ? (
        <p className="muted">No phones paired yet.</p>
      ) : null}
      <ul className="list">
        {(devices ?? []).map((device) => (
          <li key={device.id}>
            <div>
              <strong>{device.name}</strong>
              <span className="muted">
                {device.revoked
                  ? 'Removed'
                  : device.lastSeen === null
                    ? `Paired ${when(device.createdAt)}, not seen since`
                    : `Last seen ${when(device.lastSeen)}`}
              </span>
            </div>
            {device.revoked ? null : confirming === device.id ? (
              <div className="actions">
                <button className="danger" onClick={() => void revoke(device.id)}>
                  Remove this phone
                </button>
                <button className="secondary" onClick={() => setConfirming(null)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setConfirming(device.id)}>
                Remove…
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
