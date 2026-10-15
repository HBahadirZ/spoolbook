// Spoolbook Pro: a one-time, durable add-on sold through the Microsoft Store.
// Uses the Digital Goods API + Payment Request API, which work only when the
// app was installed from the Microsoft Store on Windows (Edge 134+).
// Docs: https://learn.microsoft.com/microsoft-edge/progressive-web-apps-chromium/how-to/digital-goods-api
import { CONFIG } from './config.js';

const BILLING = 'https://store.microsoft.com/billing';
const CACHE_KEY = 'spoolbook.pro';

const state = { owned: false, available: false, price: CONFIG.proPriceFallback, service: null, source: 'none' };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn({ ...state }));

export const onProChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const isPro = () => state.owned;
export const proState = () => ({ ...state });

function readCache() { try { return localStorage.getItem(CACHE_KEY) === '1'; } catch { return false; } }
function writeCache(v) { try { localStorage.setItem(CACHE_KEY, v ? '1' : '0'); } catch { /* ignore */ } }

function devOverride() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) return null;
  const p = new URLSearchParams(location.search).get('pro');
  if (p === '1') return true;
  if (p === '0') return false;
  return null;
}

export async function initPro() {
  const dev = devOverride();
  if (dev !== null) { state.owned = dev; state.source = 'dev'; state.available = true; emit(); return; }

  // Last confirmed answer, so Pro keeps working offline.
  state.owned = readCache();
  if (typeof window.getDigitalGoodsService !== 'function') { emit(); return; }
  try {
    state.service = await window.getDigitalGoodsService(BILLING);
    state.available = true;
    await refreshOwnership();
    try {
      const [item] = await state.service.getDetails([CONFIG.proItemId]);
      if (item && item.price) {
        state.price = new Intl.NumberFormat(navigator.language, { style: 'currency', currency: item.price.currency }).format(item.price.value);
      }
    } catch { /* keep fallback price */ }
  } catch {
    // Not installed from the Store (e.g. running in a browser tab).
    state.service = null;
    state.available = false;
  }
  emit();
}

async function refreshOwnership() {
  if (!state.service) return;
  const purchases = await state.service.listPurchases();
  state.owned = purchases.some((p) => p.itemId === CONFIG.proItemId);
  state.source = 'store';
  writeCache(state.owned);
}

/** Opens the Store purchase dialog. Resolves true when Pro is owned afterwards. */
export async function buyPro() {
  if (!state.service) throw new Error('not-store');
  const request = new PaymentRequest(
    [{ supportedMethods: BILLING, data: { sku: CONFIG.proItemId } }],
    // Required by the Payment Request constructor; the Store shows its own price.
    { total: { label: 'Spoolbook Pro', amount: { currency: 'USD', value: '0' } } },
  );
  const response = await request.show(); // rejects if the user cancels
  try { await response.complete('success'); } catch { /* some hosts complete automatically */ }
  await refreshOwnership();
  emit();
  return state.owned;
}

/** Re-checks the Store, e.g. after reinstalling on a new PC. */
export async function restorePro() {
  await refreshOwnership();
  emit();
  return state.owned;
}

export function storeLink() {
  return CONFIG.storeProductId
    ? `https://apps.microsoft.com/detail/${CONFIG.storeProductId.toLowerCase()}`
    : 'https://apps.microsoft.com/search?query=Spoolbook';
}
