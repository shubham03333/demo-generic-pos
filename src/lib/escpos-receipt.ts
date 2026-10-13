import type { Order } from '@/types';

const WIDTH = 32;
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function latin1(text: string): number[] {
  return Array.from(text).map((ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x20ac || ch === '₹') return 0x52; // printers rarely have rupee; use Rs prefix in layout
    return code < 256 ? code : 0x3f;
  });
}

function line(left: string, right = ''): string {
  const room = WIDTH - right.length;
  const l = left.length > room ? `${left.slice(0, Math.max(0, room - 1))}…` : left;
  const pad = Math.max(1, WIDTH - l.length - right.length);
  return right ? `${l}${' '.repeat(pad)}${right}` : l.padEnd(WIDTH);
}

function dash(): string {
  return '-'.repeat(WIDTH);
}

export function encodeEscPosReceipt(order: Order): Uint8Array {
  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);
  const text = (value: string, extraLf = 1) => {
    push(...latin1(value.replace(/₹/g, 'Rs.')));
    for (let i = 0; i < extraLf; i += 1) push(LF);
  };
  const align = (n: 0 | 1 | 2) => push(ESC, 0x61, n);
  const bold = (on: boolean) => push(ESC, 0x45, on ? 1 : 0);
  const double = (on: boolean) => push(GS, 0x21, on ? 0x11 : 0x00);

  const now = new Date();
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const orderNo = String(order.order_number ?? '').padStart(3, '0');
  const gross = Number(order.gross_total ?? order.total) || 0;
  const discount = Number(order.discount_total) || 0;
  const net = Number(order.total) || 0;

  push(ESC, 0x40);
  align(1);
  double(true);
  bold(true);
  text('ADDA CAFE');
  double(false);
  bold(false);
  text('* Pure Veg * Fresh * Tasty *');
  align(0);
  text(dash());
  align(1);
  text('Jagdale Complex, Tuljapur');
  text('Ph: +91-7558379410');
  align(0);
  text(dash());
  align(1);
  bold(true);
  text(`Order # ${orderNo}`);
  bold(false);
  text(`Date : ${date} ${time}`);
  if (order.order_type === 'DINE_IN' && order.table_code) {
    text(`Table   : ${order.table_code}`);
  } else if (order.order_type && order.order_type !== 'DINE_IN') {
    text(`Type    : ${String(order.order_type).replace('_', ' ')}`);
  } else {
    text('Type    : TAKEAWAY');
  }
  if (order.customer_name) text(`Name    : ${order.customer_name}`);
  if (order.customer_phone) text(`Mobile  : ${order.customer_phone}`);
  align(0);
  text(dash());
  bold(true);
  text(line('Item', 'Amt'));
  bold(false);
  text(dash());

  (order.items || []).forEach((item) => {
    const qty = Number(item.quantity) || 0;
    const amt = ((Number(item.price) || 0) * qty).toFixed(2);
    const name = `${qty}x ${item.name || ''}`.trim();
    text(line(name, amt));
  });

  text(dash());
  if (discount > 0) {
    text(line('GROSS', `Rs.${gross.toFixed(2)}`));
    text(line(`DISC${order.offer_code ? ` ${order.offer_code}` : ''}`, `-Rs.${discount.toFixed(2)}`));
  }
  align(2);
  bold(true);
  double(true);
  text(`TOTAL Rs.${net.toFixed(2)}`);
  double(false);
  bold(false);
  align(0);
  text(dash());
  align(1);
  text('Thank you! Visit again :)');
  align(0);
  push(LF, LF, LF, LF);
  // Portable 58mm units usually have no cutter; extra feed is enough.

  return Uint8Array.from(out);
}
