import type { Order } from '@/types';
import { encodeEscPosReceipt } from '@/lib/escpos-receipt';

const STORAGE_KEY = 'adda-pos-printer';

export type SavedPrinter = {
  address: string;
  name: string;
};

export type PrintOutcome =
  | { ok: true }
  | { ok: false; needSetup: true; message: string }
  | { ok: false; needSetup: false; message: string };

export async function isNativePos(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function prefs() {
  const { Preferences } = await import('@capacitor/preferences');
  return Preferences;
}

async function thermal() {
  return import('@devlas/capacitor-thermal-printer');
}

export async function getSavedPrinter(): Promise<SavedPrinter | null> {
  try {
    const Preferences = await prefs();
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (value) return JSON.parse(value) as SavedPrinter;
  } catch {
    // fall through to localStorage
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedPrinter) : null;
  } catch {
    return null;
  }
}

export async function savePrinter(printer: SavedPrinter): Promise<void> {
  const payload = JSON.stringify(printer);
  try {
    const Preferences = await prefs();
    await Preferences.set({ key: STORAGE_KEY, value: payload });
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // ignore
  }
}

export async function clearSavedPrinter(): Promise<void> {
  try {
    const Preferences = await prefs();
    await Preferences.remove({ key: STORAGE_KEY });
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function listBluetoothPrinters(): Promise<SavedPrinter[]> {
  const { ThermalPrinter } = await thermal();
  const { devices } = await ThermalPrinter.list({ transport: 'bluetooth' });
  return (devices || [])
    .filter((d: any) => d?.address)
    .map((d: any) => ({
      address: String(d.address),
      name: String(d.name || d.address),
    }));
}

export async function printOrderReceipt(order: Order, printer?: SavedPrinter | null): Promise<PrintOutcome> {
  const native = await isNativePos();
  if (!native) {
    return { ok: false, needSetup: false, message: 'Native printing is only available in the Adda Cafe Android app.' };
  }

  const target = printer ?? (await getSavedPrinter());
  if (!target?.address) {
    return { ok: false, needSetup: true, message: 'Choose this tablet’s printer first.' };
  }

  try {
    const { ThermalPrinter, bytesToBase64 } = await thermal();
    await ThermalPrinter.requestPermission({
      transport: 'bluetooth',
      address: target.address,
    });
    const bytes = encodeEscPosReceipt(order);
    await ThermalPrinter.print({
      transport: 'bluetooth',
      address: target.address,
      data: bytesToBase64(bytes),
    });
    return { ok: true };
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code === 'permission_denied') {
      return { ok: false, needSetup: true, message: 'Bluetooth permission is required to print.' };
    }
    if (code === 'not_found' || code === 'connect_failed') {
      return {
        ok: false,
        needSetup: true,
        message: 'Could not reach the printer. Pair the SEZNIK Veer in Android Bluetooth settings, then select it here.',
      };
    }
    return {
      ok: false,
      needSetup: false,
      message: error?.message || 'Print failed. Check that the printer is on and in range.',
    };
  }
}
