// Local persistence. Everything stays on this PC.
const KEY = 'spoolbook.v1';
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function guessCurrency(locale) {
  const region = (locale.split('-')[1] || '').toUpperCase();
  const map = { US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', TR: 'TRY', IN: 'INR', MX: 'MXN', JP: 'JPY' };
  return map[region] || 'USD';
}

export function defaultSettings() {
  return {
    currency: guessCurrency(navigator.language || 'en-US'),
    electricityRate: '0.16', laborRate: '20', taxPct: '', feePct: '', feeFixed: '', roundTo: '',
    defaultFailurePct: '10', defaultMarkupPct: '100',
    business: { name: '', phone: '', email: '', website: '' },
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.jobs)) {
        d.settings = { ...defaultSettings(), ...(d.settings || {}) };
        d.settings.business = { ...defaultSettings().business, ...(d.settings.business || {}) };
        d.printers ||= []; d.spools ||= []; d.view ||= 'quote';
        return d;
      }
    }
  } catch { /* storage unavailable or corrupt */ }
  return { printers: [], spools: [], jobs: [], activeJobId: null, view: 'quote', settings: defaultSettings() };
}

let timer;
export function save(state, now = false) {
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; } };
  clearTimeout(timer);
  if (now) return write();
  timer = setTimeout(write, 250);
  return true;
}

export const newPrinter = (name = 'My printer') => ({ id: uid(), name, watts: '120', price: '', lifeHours: '5000', maintPerHour: '0.05' });
export const newSpool = (name = 'Generic PLA') => ({ id: uid(), name, material: 'PLA', color: '#9AA0A6', price: '20', weightG: '1000', remainingG: '1000', diameter: '1.75', density: '' });
export const newFilamentLine = (spoolId = '') => ({ id: uid(), spoolId, grams: '' });
export const newPrint = (label = 'Print 1', spoolId = '') => ({ id: uid(), label, time: '', runs: '1', filaments: [newFilamentLine(spoolId)], source: null });

export function newJob(state, name = 'New quote') {
  const now = new Date().toISOString();
  return {
    id: uid(), name, client: '', createdAt: now, updatedAt: now,
    printerId: state.printers[0]?.id || '', units: '1', setupMin: '10', postMinPerRun: '5',
    failurePct: state.settings.defaultFailurePct, markupPct: state.settings.defaultMarkupPct,
    extras: [], prints: [newPrint('Print 1', state.spools[0]?.id || '')], notes: '', printed: null,
  };
}

export function sampleSetup(state, { secondPrinter = true } = {}) {
  const printer = { id: uid(), name: 'Bambu Lab P1S', watts: '110', price: '699', lifeHours: '5000', maintPerHour: '0.08' };
  const printer2 = { id: uid(), name: 'Prusa MK4S', watts: '90', price: '1099', lifeHours: '8000', maintPerHour: '0.06' };
  const spools = [
    { id: uid(), name: 'Matte charcoal PLA', material: 'PLA', color: '#3A3D42', price: '19.99', weightG: '1000', remainingG: '640', diameter: '1.75', density: '' },
    { id: uid(), name: 'Silk gold PLA', material: 'PLA', color: '#D4A843', price: '24.99', weightG: '1000', remainingG: '880', diameter: '1.75', density: '' },
    { id: uid(), name: 'Translucent teal PETG', material: 'PETG', color: '#2A9D8F', price: '22.50', weightG: '1000', remainingG: '120', diameter: '1.75', density: '' },
    { id: uid(), name: 'Bone white PLA', material: 'PLA', color: '#EFE9DD', price: '18.99', weightG: '1000', remainingG: '930', diameter: '1.75', density: '' },
    { id: uid(), name: 'Black TPU 95A', material: 'TPU', color: '#151515', price: '29.99', weightG: '1000', remainingG: '450', diameter: '1.75', density: '' },
  ];
  const now = new Date().toISOString();
  const job = {
    id: uid(), name: 'Sample: geometric planters for Lena\'s shop', client: 'Lena Ortiz', createdAt: now, updatedAt: now,
    printerId: printer.id, units: '6', setupMin: '20', postMinPerRun: '6',
    failurePct: '8', markupPct: '120',
    extras: [{ id: uid(), label: 'Drainage plugs (6)', cost: '3.60' }, { id: uid(), label: 'Gift boxes (6)', cost: '7.20' }],
    prints: [
      { id: uid(), label: 'Planter body', time: '2h 38m', runs: '6', filaments: [{ id: uid(), spoolId: spools[0].id, grams: '41.38' }], source: 'bambu-studio-planter.gcode' },
      { id: uid(), label: 'Gold trim ring', time: '42m', runs: '3', filaments: [{ id: uid(), spoolId: spools[1].id, grams: '13.6' }], source: null },
    ],
    notes: 'Ready 5 business days after approval. Colours may vary slightly between filament batches.', printed: null,
  };
  state.printers.push(printer);
  if (secondPrinter) state.printers.push(printer2);
  state.spools.push(...spools);
  state.jobs.push(job);
  state.activeJobId = job.id;
  state.settings.taxPct ||= '';
  return job;
}
