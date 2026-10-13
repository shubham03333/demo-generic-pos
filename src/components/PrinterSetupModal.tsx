'use client';

import React, { useEffect, useState } from 'react';
import { Bluetooth, X } from 'lucide-react';
import {
  clearSavedPrinter,
  getSavedPrinter,
  listBluetoothPrinters,
  savePrinter,
  type SavedPrinter,
} from '@/lib/native-printer';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved?: (printer: SavedPrinter) => void;
};

export default function PrinterSetupModal({ open, onClose, onSaved }: Props) {
  const [saved, setSaved] = useState<SavedPrinter | null>(null);
  const [devices, setDevices] = useState<SavedPrinter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setSaved(await getSavedPrinter());
      setDevices(await listBluetoothPrinters());
    } catch (err: any) {
      setError(err?.message || 'Could not list Bluetooth printers. Allow Bluetooth permission and pair the SEZNIK Veer in Android settings first.');
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Receipt printer</h2>
            <p className="mt-1 text-sm text-zinc-500">
              One SEZNIK Veer per phone or tablet. Pair it in Android Bluetooth settings, then tap it here. Printing stays inside Adda Cafe.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {saved ? (
          <div className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Saved: <span className="font-semibold">{saved.name}</span>
          </div>
        ) : (
          <div className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No printer saved on this device yet.
          </div>
        )}

        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

        <div className="max-h-64 space-y-2 overflow-y-auto">
          {loading ? (
            <p className="py-6 text-center text-sm text-zinc-500">Looking for paired printers…</p>
          ) : devices.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              None listed. On the phone: Settings → Bluetooth → pair “SEZNIK” / “Veer” / “Printerxxxx”, then tap Refresh.
            </p>
          ) : (
            devices.map((device) => (
              <button
                key={device.address}
                type="button"
                onClick={async () => {
                  await savePrinter(device);
                  setSaved(device);
                  onSaved?.(device);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left ring-1 ${
                  saved?.address === device.address
                    ? 'bg-zinc-900 text-white ring-zinc-900'
                    : 'bg-zinc-50 text-zinc-900 ring-zinc-200 hover:bg-zinc-100'
                }`}
              >
                <Bluetooth className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{device.name}</span>
                  <span className="block truncate text-xs opacity-70">{device.address}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="min-h-[44px] flex-1 rounded-xl bg-zinc-900 text-sm font-medium text-white"
          >
            Refresh
          </button>
          {saved ? (
            <button
              type="button"
              onClick={async () => {
                await clearSavedPrinter();
                setSaved(null);
              }}
              className="min-h-[44px] rounded-xl px-4 text-sm font-medium text-red-700 ring-1 ring-red-200"
            >
              Forget
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
