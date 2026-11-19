import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { adb } from './adb.js';

/**
 * "Pair device with QR code" (Android 11+ wireless debugging), the same protocol Android Studio uses:
 *  1. We show a QR with  WIFI:T:ADB;S:<service name>;P:<password>;;
 *  2. The phone scans it and advertises an mDNS service  <service name>._adb-tls-pairing._tcp  on the LAN.
 *  3. We find it with `adb mdns services`, run `adb pair ip:port password`,
 *  4. then connect to the phone's _adb-tls-connect service (adb often auto-connects by itself).
 */

export type QrStatus = 'waiting' | 'pairing' | 'connecting' | 'connected' | 'failed' | 'expired' | 'cancelled';

export interface QrSession {
  id: string;
  service_name: string;
  qr_svg: string;
  status: QrStatus;
  message: string;
  device_address: string | null;
  serial: string | null;
  created_at: string;
  expires_at: string;
}

const TTL_MS = 3 * 60_000;
const sessions = new Map<string, QrSession & { password: string }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Alphanumeric only — no escaping needed inside the WIFI: QR payload, safe as an adb argument.
const randomToken = (len: number) => {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
};

const pub = ({ password, ...s }: QrSession & { password: string }): QrSession => s;

export const qrPairing = {
  async start(): Promise<QrSession> {
    // Only one live session at a time keeps the mDNS matching unambiguous.
    for (const s of sessions.values()) if (['waiting', 'pairing', 'connecting'].includes(s.status)) s.status = 'cancelled';

    const mdns = await adb.mdnsCheck();
    if (!mdns.ok) {
      await adb.restartServer(); // restarts with ADB_MDNS_OPENSCREEN=1
      const again = await adb.mdnsCheck();
      if (!again.ok)
        throw Object.assign(new Error(`ADB mDNS discovery is not available (${again.message}). Update Android SDK Platform-Tools, or use the pairing-code method.`), {
          statusCode: 412,
        });
    }

    const serviceName = `playtest-${randomToken(10)}`;
    const password = randomToken(12);
    const qrText = `WIFI:T:ADB;S:${serviceName};P:${password};;`;
    const qr_svg = await QRCode.toString(qrText, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    const now = Date.now();
    const s = {
      id: randomToken(16),
      service_name: serviceName,
      password,
      qr_svg,
      status: 'waiting' as QrStatus,
      message: 'Waiting for the phone to scan the QR code…',
      device_address: null,
      serial: null,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + TTL_MS).toISOString(),
    };
    sessions.set(s.id, s);
    for (const [id, old] of sessions) if (id !== s.id && Date.parse(old.expires_at) < now - TTL_MS) sessions.delete(id);
    void watch(s);
    return pub(s);
  },

  get(id: string): QrSession | null {
    const s = sessions.get(id);
    return s ? pub(s) : null;
  },

  cancel(id: string) {
    const s = sessions.get(id);
    if (s && ['waiting', 'pairing', 'connecting'].includes(s.status)) {
      s.status = 'cancelled';
      s.message = 'Cancelled';
    }
    return s ? pub(s) : null;
  },
};

async function watch(s: QrSession & { password: string }) {
  const deadline = Date.parse(s.expires_at);
  const set = (status: QrStatus, message: string) => {
    s.status = status;
    s.message = message;
  };
  const live = () => s.status !== 'cancelled';

  // 1. Wait for the phone to advertise our pairing service.
  let pairAddr: string | null = null;
  while (live() && Date.now() < deadline) {
    const found = (await adb.mdnsServices()).find((x) => x.type.startsWith('_adb-tls-pairing') && x.name === s.service_name);
    if (found) {
      pairAddr = found.address;
      break;
    }
    await sleep(1500);
  }
  if (!live()) return;
  if (!pairAddr) return set('expired', 'QR code expired — no phone scanned it. Check the phone is on the same Wi-Fi, then make a new code.');

  // 2. Pair.
  s.device_address = pairAddr;
  set('pairing', `Phone found at ${pairAddr} — pairing…`);
  let paired: { ok: boolean; message: string };
  try {
    paired = await adb.pair(pairAddr, s.password);
  } catch (err: any) {
    return set('failed', err.message);
  }
  if (!paired.ok) return set('failed', `Pairing failed: ${paired.message}`);

  // 3. Connect: the phone now advertises _adb-tls-connect on the same IP (different port).
  const ip = pairAddr.split(':')[0];
  set('connecting', 'Paired — connecting…');
  const connectDeadline = Date.now() + 30_000;
  let triedManual = false;
  while (live() && Date.now() < connectDeadline) {
    const [services, { devices }] = await Promise.all([adb.mdnsServices(), adb.devices()]);
    const svc = services.find((x) => x.type.startsWith('_adb-tls-connect') && x.address.startsWith(`${ip}:`));
    const match = devices.find((d) => d.serial.startsWith(`${ip}:`) || (svc && d.serial.startsWith(`${svc.name}._adb-tls-connect`)));
    if (match && match.state === 'device') {
      s.serial = match.serial;
      return set('connected', `Connected ${match.model ?? match.serial}`);
    }
    if (svc && !triedManual && Date.now() > connectDeadline - 26_000) {
      triedManual = true;
      await adb.connect(svc.address).catch(() => null);
    }
    await sleep(1500);
  }
  if (!live()) return;
  set('failed', `Paired, but the phone did not connect. On the phone's Wireless debugging screen, use "IP address & port" with the IP:port method.`);
}
