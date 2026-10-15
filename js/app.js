import * as C from './calc.js';
import { parseSlicedFile } from './gcode.js';
import { load, save, uid, newPrinter, newSpool, newPrint, newFilamentLine, newJob, sampleSetup } from './storage.js';
import { initPro, isPro, onProChange, buyPro, restorePro, proState, storeLink } from './pro.js';
import { CONFIG } from './config.js';

const state = load();
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const side = $('#side');

const activeJob = () => state.jobs.find((j) => j.id === state.activeJobId) || null;
const persist = (now = false) => save(state, now);
const touchJob = (j) => { if (j) j.updatedAt = new Date().toISOString(); persist(); };

// ------------------------------------------------------------ formatting
const nf = (d) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d });
const fmt = (n, d = 1) => (Number.isFinite(n) ? nf(d).format(n) : '–');
function money(n, opts = {}) {
  if (!Number.isFinite(n)) return '–';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, ...opts }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}
function currencySymbol() {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((x) => x.type === 'currency').value;
  } catch { return '$'; }
}
const density = (sp) => { const d = C.num(sp?.density); return Number.isFinite(d) && d > 0 ? d : (C.MATERIALS[sp?.material] || 1.24); };
const diameter = (sp) => { const d = C.num(sp?.diameter); return Number.isFinite(d) && d > 0 ? d : 1.75; };
const remainingFrac = (sp) => {
  const w = C.num(sp.weightG), r = C.num(sp.remainingG);
  return Number.isFinite(w) && w > 0 && Number.isFinite(r) ? Math.max(0, Math.min(1, r / w)) : 0;
};

const ICON = {
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3M6 9h4M6 11.5h4"/></svg>',
};

function spoolSvg(sp, size = 64) {
  const f = remainingFrac(sp);
  const hub = 15, max = 45;
  const r = hub + (max - hub) * f;
  const rings = [];
  for (let k = hub + 3; k < r; k += 3.2) rings.push(`<circle cx="50" cy="50" r="${k.toFixed(1)}" class="wind"/>`);
  return `<svg class="spool" viewBox="0 0 100 100" style="--spool-size:${size}px" aria-hidden="true">
    <circle cx="50" cy="50" r="48" class="flange"/>
    ${f > 0 ? `<circle cx="50" cy="50" r="${r.toFixed(1)}" fill="${esc(sp.color || '#999')}"/>` : ''}
    ${rings.join('')}
    <circle cx="50" cy="50" r="${hub}" class="hub"/>
    <circle cx="50" cy="50" r="6" class="axle"/>
  </svg>`;
}
const swatch = (sp) => `<span class="swatch" style="--c:${esc(sp?.color || '#999')}"></span>`;

// --------------------------------------------------------------- fields
function field(o) {
  const id = o.id || `f-${o.path.replace(/[^a-z0-9]/gi, '-')}`;
  const locked = o.locked ? ' disabled' : '';
  const label = `<span class="label">${esc(o.label)}${o.locked ? ` <span class="pro-tag">${ICON.lock}Pro</span>` : ''}</span>`;
  if (o.type === 'select') {
    return `<label class="field${o.wide ? ' wide' : ''}${o.locked ? ' locked' : ''}" for="${id}">${label}
      <select id="${id}" data-path="${o.path}"${o.rerender ? ' data-rerender' : ''}${locked}>
        ${o.options.map((op) => `<option value="${esc(op.value)}"${String(op.value) === String(o.value) ? ' selected' : ''}>${esc(op.label)}</option>`).join('')}
      </select>${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</label>`;
  }
  if (o.type === 'color') {
    return `<label class="field color-field" for="${id}">${label}<input type="color" id="${id}" data-path="${o.path}" value="${esc(o.value)}" data-rerender></label>`;
  }
  return `<label class="field${o.wide ? ' wide' : ''}${o.locked ? ' locked' : ''}" for="${id}">${label}
    <span class="control"><input id="${id}" data-path="${o.path}" value="${esc(o.value)}" inputmode="${o.inputmode || 'decimal'}" placeholder="${esc(o.placeholder || '')}"
      autocomplete="off" spellcheck="false"${o.kind ? ` data-kind="${o.kind}"` : ''}${o.rerender ? ' data-rerender' : ''}${locked}>${o.suffix ? `<span class="suffix">${esc(o.suffix)}</span>` : ''}</span>
    ${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</label>`;
}

// ---------------------------------------------------------------- views
function render() {
  renderBar();
  document.body.dataset.view = state.view;
  if (state.view === 'spools') renderSpools();
  else if (state.view === 'printers') renderPrinters();
  else renderQuote();
}

function renderBar() {
  for (const t of $$('.tabs [data-view]')) t.setAttribute('aria-current', t.dataset.view === state.view ? 'page' : 'false');
  const sel = $('#jobSelect');
  const jobs = [...state.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sel.innerHTML = jobs.length ? jobs.map((j) => `<option value="${j.id}"${j.id === state.activeJobId ? ' selected' : ''}>${esc(j.name || 'Untitled quote')}</option>`).join('') : '<option>No quotes yet</option>';
  sel.disabled = !jobs.length;
  sel.hidden = state.view !== 'quote';
  $('#newJobBtn').hidden = state.view !== 'quote';
  $('#proBadge').hidden = !isPro();
  $('#getPro').hidden = isPro();
}

// ----- quote view
function renderQuote() {
  const job = activeJob();
  if (!job) {
    side.innerHTML = '';
    main.innerHTML = `<div class="welcome">
      <h1>What does this print really cost?</h1>
      <p>Drop in a sliced file from PrusaSlicer, Bambu Studio, OrcaSlicer, Cura or Simplify3D. Spoolbook reads the filament
        and print time, adds electricity, printer wear, labour and failed prints, and suggests a price you can quote.</p>
      <div class="row">
        <button class="btn primary" data-action="sample">Start with a sample setup</button>
        <button class="btn" data-action="new-job">${ICON.plus}New quote</button>
      </div>
      <p class="fine">Your printers, spools and quotes stay on this PC.</p>
    </div>`;
    return;
  }
  const printers = state.printers;
  main.innerHTML = `
    <div class="job-head">
      <label class="sr-only" for="f-j-name">Quote name</label>
      <input id="f-j-name" class="job-name" data-path="j.name" value="${esc(job.name)}" placeholder="Quote name" autocomplete="off">
      <div class="grid">
        ${field({ path: 'j.client', label: 'Client', value: job.client, inputmode: 'text', placeholder: 'Optional' })}
        ${field({ path: 'j.printerId', label: 'Printer', type: 'select', value: job.printerId, rerender: true, options: printers.length ? printers.map((p) => ({ value: p.id, label: p.name || 'Unnamed printer' })) : [{ value: '', label: 'Add a printer first' }] })}
        ${field({ path: 'j.units', label: 'Pieces in this order', value: job.units, inputmode: 'numeric', kind: 'number', hint: 'Used for the price per piece.' })}
      </div>
      <div class="job-actions">
        <button class="btn quiet" data-action="duplicate-job">Duplicate quote</button>
        <button class="btn quiet danger" data-action="delete-job">Delete quote</button>
      </div>
    </div>

    <section class="block" aria-labelledby="h-prints">
      <div class="block-head"><h2 id="h-prints">Prints</h2>
        <p class="block-note">Drop a .gcode or .gcode.3mf file anywhere on this page, or enter the slicer's numbers yourself.</p></div>
      <div class="prints">${job.prints.map((p, i) => printCard(job, p, i)).join('')}</div>
      <div class="row">
        <button class="btn add" data-action="add-print">${ICON.plus}Add print</button>
        <label class="btn add file-btn">${ICON.file}Read a sliced file<input type="file" id="fileInput" accept=".gcode,.gco,.g,.3mf,.bgcode" hidden></label>
      </div>
    </section>

    <section class="block" aria-labelledby="h-labour">
      <div class="block-head"><h2 id="h-labour">Labour and extras</h2>
        <p class="block-note">At ${money(C.num(state.settings.laborRate) || 0)} an hour. Change the rate in Settings.</p></div>
      <div class="grid">
        ${field({ path: 'j.setupMin', label: 'Design and setup', value: job.setupMin, suffix: 'min', kind: 'number', hint: 'Once per order: slicing, file prep, messages.' })}
        ${field({ path: 'j.postMinPerRun', label: 'Finishing per print', value: job.postMinPerRun, suffix: 'min', kind: 'number', hint: 'Plate removal, support cleanup, sanding.' })}
      </div>
      <div class="extras">
        ${job.extras.map((e) => `<div class="extra-row">
          <label class="sr-only" for="f-e-${e.id}">Extra item</label>
          <input id="f-e-${e.id}" data-path="e.${e.id}.label" value="${esc(e.label)}" placeholder="Hardware, magnets, packaging" autocomplete="off">
          <span class="control"><input aria-label="Cost" data-path="e.${e.id}.cost" data-kind="number" value="${esc(e.cost)}" inputmode="decimal" placeholder="0.00"><span class="suffix">${esc(currencySymbol())}</span></span>
          <button class="icon-btn" data-action="remove-extra" data-id="${e.id}" aria-label="Remove ${esc(e.label || 'extra')}">${ICON.x}</button>
        </div>`).join('')}
      </div>
      <button class="btn link" data-action="add-extra">${ICON.plus}Add an extra cost</button>
    </section>

    <section class="block" aria-labelledby="h-pricing">
      <div class="block-head"><h2 id="h-pricing">Pricing</h2></div>
      <div class="grid">
        ${field({ path: 'j.failurePct', label: 'Failed print allowance', value: job.failurePct, suffix: '%', kind: 'number', hint: 'Added to filament, power and wear to cover reprints.' })}
        ${field({ path: 'j.markupPct', label: 'Markup on cost', value: job.markupPct, suffix: '%', kind: 'number', hint: '100% doubles the cost.' })}
      </div>
    </section>

    <section class="block" aria-labelledby="h-notes">
      <div class="block-head"><h2 id="h-notes">Notes for the quote</h2></div>
      <label class="sr-only" for="f-j-notes">Notes for the quote</label>
      <textarea id="f-j-notes" data-path="j.notes" rows="3" placeholder="Lead time, colours, what's included">${esc(job.notes)}</textarea>
    </section>`;
  updateQuote();
}

function printCard(job, p, i) {
  const spoolOptions = [{ value: '', label: state.spools.length ? 'Pick a spool' : 'Add a spool first' }, ...state.spools.map((s) => ({ value: s.id, label: `${s.name || 'Unnamed'} (${s.material})` }))];
  return `<article class="print" data-print="${p.id}">
    <header class="print-head">
      <label class="sr-only" for="f-p-${p.id}">Print name</label>
      <input id="f-p-${p.id}" class="print-name" data-path="p.${p.id}.label" value="${esc(p.label)}" placeholder="Print ${i + 1}" autocomplete="off">
      ${p.source ? `<span class="source" title="Read from this file">${ICON.file}${esc(p.source)}</span>` : ''}
      <output class="print-cost" data-print-cost="${p.id}"></output>
      ${job.prints.length > 1 ? `<button class="icon-btn" data-action="remove-print" data-id="${p.id}" aria-label="Remove ${esc(p.label || 'print')}">${ICON.x}</button>` : ''}
    </header>
    <div class="print-body">
      <div class="grid">
        ${field({ path: `p.${p.id}.time`, label: 'Print time', value: p.time, inputmode: 'text', placeholder: '2h 30m', kind: 'duration', hint: 'As the slicer shows it: 2h 30m, 1:45 or 95m.' })}
        ${field({ path: `p.${p.id}.runs`, label: 'Times printed', value: p.runs, inputmode: 'numeric', kind: 'number', hint: 'How many plates of this you will run.' })}
      </div>
      <div class="filaments">
        ${p.filaments.map((f) => {
          const sp = state.spools.find((s) => s.id === f.spoolId);
          return `<div class="fil-row">
            ${swatch(sp)}
            <label class="sr-only" for="f-f-${f.id}">Spool</label>
            <select id="f-f-${f.id}" data-path="f.${p.id}.${f.id}.spoolId" data-rerender>${spoolOptions.map((o) => `<option value="${o.value}"${o.value === f.spoolId ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
            <span class="control"><input aria-label="Filament used" data-path="f.${p.id}.${f.id}.grams" data-kind="number" value="${esc(f.grams)}" inputmode="decimal" placeholder="Weight"><span class="suffix">g</span></span>
            ${p.filaments.length > 1 ? `<button class="icon-btn" data-action="remove-filament" data-print="${p.id}" data-id="${f.id}" aria-label="Remove filament">${ICON.x}</button>` : '<span class="icon-spacer"></span>'}
          </div>`;
        }).join('')}
        <button class="btn link" data-action="add-filament" data-print="${p.id}">${ICON.plus}Add another filament</button>
      </div>
    </div>
  </article>`;
}

function updateQuote() {
  const job = activeJob();
  if (!job) return;
  validate(main);
  const r = C.costJob(job, state);
  job.prints.forEach((p, i) => {
    const out = $(`[data-print-cost="${p.id}"]`);
    const x = r.prints[i];
    if (out && x) out.textContent = x.perRun > 0 ? `${money(x.perRun)} a print${x.runs > 1 ? ` × ${x.runs}` : ''}` : '';
  });
  renderPriceCard(job, r);
}

function renderPriceCard(job, r) {
  const pro = isPro();
  const L = (label, val, cls = '') => `<div class="${cls}"><dt>${label}</dt><dd>${val}</dd></div>`;
  const usage = Object.entries(r.gramsBySpool).map(([id, g]) => {
    const sp = state.spools.find((s) => s.id === id);
    const short = r.shortages.find((x) => x.spoolId === id);
    return `<li class="${short ? 'short' : ''}">${swatch(sp)}<span>${fmt(g, 1)} g of ${esc(sp?.name || 'spool')}</span><span class="left">${short ? `only ${fmt(short.left, 0)} g left` : `${fmt(C.num(sp?.remainingG), 0)} g left`}</span></li>`;
  }).join('');
  side.innerHTML = `<div class="price-card">
    <div class="plate" aria-hidden="true"></div>
    <div class="price-body">
      <p class="price-label">Price per piece</p>
      <p class="price-big">${money(r.perUnit)}</p>
      <p class="price-sub">${r.units} ${r.units === 1 ? 'piece' : 'pieces'}, ${money(r.price)} in total. Cost ${money(r.costPerUnit)} a piece.</p>
      <dl class="breakdown">
        ${L(`Filament <span class="muted">${fmt(r.totalGrams, 0)} g</span>`, money(r.material))}
        ${L(`Electricity <span class="muted">${C.formatDuration(r.hours)}</span>`, money(r.electricity))}
        ${L('Printer wear', money(r.wear))}
        ${L(`Failed prints <span class="muted">${fmt(r.failurePct, 1)}%</span>`, money(r.failure))}
        ${L(`Labour <span class="muted">${fmt(r.laborMin, 0)} min</span>`, money(r.labor))}
        ${r.extras ? L('Extras', money(r.extras)) : ''}
        ${L('Cost', money(r.cost), 'sum')}
        ${L(`Markup <span class="muted">${fmt(r.markupPct, 1)}%</span>`, money(r.price - r.cost))}
        ${L('Price', money(r.price), 'sum strong')}
        ${r.tax ? L('Tax', money(r.tax)) : ''}
        ${r.tax ? L('Customer pays', money(r.total), 'sum') : ''}
      </dl>
      ${pro ? `<dl class="breakdown profit">
          ${L('Marketplace fees', money(r.fees))}
          ${L(`Profit <span class="muted">${fmt(r.margin * 100, 0)}% margin</span>`, money(r.profit), `sum strong ${r.profit < 0 ? 'neg' : ''}`)}
        </dl>`
        : `<button class="btn quiet profit-lock" data-action="open-pro">${ICON.lock}See profit after marketplace fees</button>`}
      ${usage ? `<ul class="usage">${usage}</ul>` : ''}
      ${r.warnings.length ? `<ul class="warns">${[...new Set(r.warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="price-actions">
        <button class="btn primary" data-action="print">Print or save quote</button>
        <div class="row">
          <button class="btn" data-action="copy">Copy summary</button>
          <button class="btn" data-action="export-csv">${pro ? '' : ICON.lock}Export CSV</button>
        </div>
        ${job.printed
          ? `<button class="btn quiet" data-action="unmark-printed">Printed ${new Date(job.printed.at).toLocaleDateString()}. Put the filament back</button>`
          : `<button class="btn" data-action="mark-printed"${r.totalGrams ? '' : ' disabled'}>Mark as printed and use filament</button>`}
      </div>
    </div>
  </div>`;
}

function validate(root) {
  for (const input of $$('input[data-kind]', root)) {
    const v = input.value.trim();
    let ok = true;
    if (v) ok = input.dataset.kind === 'duration' ? Number.isFinite(C.parseDuration(v)) : Number.isFinite(C.num(v));
    input.classList.toggle('invalid', !ok);
    input.setAttribute('aria-invalid', ok ? 'false' : 'true');
  }
}

// ----- spools view
function renderSpools() {
  const cur = currencySymbol();
  const sorted = [...state.spools];
  main.innerHTML = `<div class="view-head"><h1>Spools</h1>
      <p class="block-note">${state.spools.length ? `${state.spools.length} spools, ${fmt(state.spools.reduce((a, s) => a + (C.num(s.remainingG) || 0), 0) / 1000, 2)} kg on hand. Marking a quote as printed takes the filament off these spools.` : 'Add the filament you own so quotes use your real prices.'}</p></div>
    <div class="spool-grid">
      ${sorted.map((s) => {
        const cpg = C.spoolCostPerGram(s);
        const left = C.num(s.remainingG);
        const meters = Number.isFinite(left) ? C.lengthFromGrams(left, diameter(s), density(s)) / 1000 : NaN;
        const low = Number.isFinite(left) && (left < 150 || remainingFrac(s) < 0.15);
        return `<article class="spool-card${low ? ' low' : ''}" data-spool="${s.id}">
          <header class="spool-head">
            ${spoolSvg(s, 88)}
            <div class="spool-title">
              <label class="sr-only" for="f-s-${s.id}-name">Spool name</label>
              <input id="f-s-${s.id}-name" class="spool-name" data-path="s.${s.id}.name" value="${esc(s.name)}" placeholder="Spool name" autocomplete="off">
              <p class="spool-stats"><strong>${fmt(left, 0)} g</strong> left${Number.isFinite(meters) ? `, about ${fmt(meters, 0)} m` : ''}${low ? ' <span class="low-tag">Running low</span>' : ''}</p>
              <p class="spool-stats">${Number.isFinite(cpg) ? `${money(cpg * 1000)} per kg` : 'Add price and weight'}</p>
            </div>
            <button class="icon-btn" data-action="remove-spool" data-id="${s.id}" aria-label="Remove ${esc(s.name || 'spool')}">${ICON.x}</button>
          </header>
          <div class="grid tight">
            ${field({ path: `s.${s.id}.material`, label: 'Material', type: 'select', value: s.material, rerender: true, options: Object.keys(C.MATERIALS).map((m) => ({ value: m, label: m })) })}
            ${field({ path: `s.${s.id}.color`, label: 'Colour', type: 'color', value: s.color })}
            ${field({ path: `s.${s.id}.price`, label: 'Spool price', value: s.price, suffix: cur, kind: 'number', rerender: true })}
            ${field({ path: `s.${s.id}.weightG`, label: 'Net weight', value: s.weightG, suffix: 'g', kind: 'number', rerender: true })}
            ${field({ path: `s.${s.id}.remainingG`, label: 'Left on spool', value: s.remainingG, suffix: 'g', kind: 'number', rerender: true, hint: 'Weigh it, minus the empty spool.' })}
            ${field({ path: `s.${s.id}.diameter`, label: 'Diameter', type: 'select', value: s.diameter, rerender: true, options: [{ value: '1.75', label: '1.75 mm' }, { value: '2.85', label: '2.85 mm' }] })}
          </div>
        </article>`;
      }).join('')}
      <button class="spool-add" data-action="add-spool">${ICON.plus}<span>Add spool</span></button>
    </div>`;
  validate(main);
  side.innerHTML = '';
}

// ----- printers view
function renderPrinters() {
  const cur = currencySymbol();
  main.innerHTML = `<div class="view-head"><h1>Printers</h1>
      <p class="block-note">Wear is the printer's price spread over its working life, plus upkeep like nozzles, belts and build plates.</p></div>
    <div class="printer-list">
      ${state.printers.map((p) => {
        const hourly = C.printerHourlyCost(p);
        const kwh = (C.num(p.watts) || 0) / 1000 * (C.num(state.settings.electricityRate) || 0);
        return `<article class="printer-card" data-printer="${p.id}">
          <header class="print-head">
            <label class="sr-only" for="f-pr-${p.id}">Printer name</label>
            <input id="f-pr-${p.id}" class="print-name" data-path="pr.${p.id}.name" value="${esc(p.name)}" placeholder="Printer name" autocomplete="off">
            <output class="print-cost">${money(hourly + kwh)} an hour</output>
            ${state.printers.length > 1 ? `<button class="icon-btn" data-action="remove-printer" data-id="${p.id}" aria-label="Remove ${esc(p.name || 'printer')}">${ICON.x}</button>` : ''}
          </header>
          <div class="print-body grid">
            ${field({ path: `pr.${p.id}.watts`, label: 'Average power while printing', value: p.watts, suffix: 'W', kind: 'number', rerender: true, hint: 'A plug-in power meter gives the real figure.' })}
            ${field({ path: `pr.${p.id}.price`, label: 'What it cost', value: p.price, suffix: cur, kind: 'number', rerender: true })}
            ${field({ path: `pr.${p.id}.lifeHours`, label: 'Expected working life', value: p.lifeHours, suffix: 'hours', kind: 'number', rerender: true, hint: 'Print hours before you would replace it.' })}
            ${field({ path: `pr.${p.id}.maintPerHour`, label: 'Upkeep per print hour', value: p.maintPerHour, suffix: cur, kind: 'number', rerender: true })}
          </div>
          <p class="printer-split">Wear ${money(hourly)} an hour, electricity ${money(kwh)} an hour at ${money(C.num(state.settings.electricityRate) || 0, { maximumFractionDigits: 3 })} per kWh.</p>
        </article>`;
      }).join('')}
    </div>
    <button class="btn add" data-action="add-printer">${ICON.plus}Add printer</button>`;
  validate(main);
  side.innerHTML = '';
}

// ---------------------------------------------------------------- quote
function buildQuote(job) {
  const r = C.costJob(job, state);
  const b = state.settings.business;
  const branded = isPro() && b.name;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = job.prints.map((p, i) => {
    const x = r.prints[i];
    const mats = p.filaments.map((f) => state.spools.find((s) => s.id === f.spoolId)).filter(Boolean).map((s) => `${s.material} ${s.name}`).join(', ');
    return `<tr><td>${esc(p.label || `Print ${i + 1}`)}<span class="q-sub">${esc(mats)}</span></td><td class="n">${x.runs}</td><td class="n">${C.formatDuration(x.hours * x.runs)}</td></tr>`;
  }).join('');
  return `<article class="quote">
    <header class="q-head">
      <div><h1>${branded ? esc(b.name) : 'Print quote'}</h1>${branded ? `<p>${[b.phone, b.email, b.website].filter(Boolean).map(esc).join('<br>')}</p>` : ''}</div>
      <div class="q-meta"><p><strong>${esc(job.name)}</strong></p>${job.client ? `<p>Prepared for ${esc(job.client)}</p>` : ''}<p>${date}</p></div>
    </header>
    <table class="q-table"><thead><tr><th>Print</th><th class="n">Plates</th><th class="n">Machine time</th></tr></thead><tbody>${lines}</tbody></table>
    <table class="q-totals"><tbody>
      <tr><td>${r.units} ${r.units === 1 ? 'piece' : 'pieces'} at ${money(r.perUnit)}</td><td class="n">${money(r.price)}</td></tr>
      ${r.tax ? `<tr><td>Tax (${fmt(C.num(state.settings.taxPct), 2)}%)</td><td class="n">${money(r.tax)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td class="n">${money(r.total)}</td></tr>
    </tbody></table>
    ${job.notes ? `<h2>Notes</h2><p>${esc(job.notes).replace(/\n/g, '<br>')}</p>` : ''}
    <footer class="q-foot">Quote valid for 30 days.${branded ? '' : ' Made with Spoolbook.'}</footer>
  </article>`;
}

function summaryText(job) {
  const r = C.costJob(job, state);
  return [
    job.name,
    `${r.units} × ${money(r.perUnit)} = ${money(r.price)}`,
    `Filament ${fmt(r.totalGrams, 0)} g, machine time ${C.formatDuration(r.hours)}`,
    `Cost ${money(r.cost)} (filament ${money(r.material)}, power ${money(r.electricity)}, wear ${money(r.wear)}, failures ${money(r.failure)}, labour ${money(r.labor)}, extras ${money(r.extras)})`,
  ].join('\n');
}

function csvFor(job) {
  const r = C.costJob(job, state);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Quote', job.name], ['Client', job.client], ['Date', new Date().toISOString().slice(0, 10)], [],
    ['Print', 'Plates', 'Hours each', 'Grams each', 'Cost each']];
  job.prints.forEach((p, i) => { const x = r.prints[i]; rows.push([p.label, x.runs, x.hours.toFixed(2), x.grams, x.perRun.toFixed(2)]); });
  rows.push([], ['Filament', r.material], ['Electricity', r.electricity], ['Printer wear', r.wear], ['Failed prints', r.failure], ['Labour', r.labor], ['Extras', r.extras],
    ['Cost', r.cost], ['Price', r.price], ['Pieces', r.units], ['Price per piece', r.perUnit], ['Marketplace fees', r.fees], ['Profit', r.profit], ['Tax', r.tax], ['Customer pays', r.total]);
  return rows.map((row) => row.map(q).join(',')).join('\r\n');
}

// --------------------------------------------------------------- toasts
let toastTimer, undoFn = null;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="btn link" data-action="undo">Undo</button>' : ''}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 7000 : 3200);
}

// ------------------------------------------------------------ limits/pro
const limitMsg = (what, n) => `The free version keeps ${n} ${what}. Get Pro for unlimited.`;
function allow(kind) {
  if (isPro()) return true;
  const n = CONFIG.free[kind];
  const have = kind === 'jobs' ? state.jobs.length : state[kind].length;
  if (have < n) return true;
  openPro(limitMsg(kind === 'jobs' ? 'quotes' : kind, n));
  return false;
}
function openPro(reason) {
  const s = proState();
  $('#proReason').textContent = reason || '';
  $('#proReason').hidden = !reason;
  $('#proPrice').textContent = s.price;
  $('#buyPro').hidden = !s.available || s.owned;
  $('#restorePro').hidden = !s.available || s.owned;
  $('#proStoreNote').hidden = s.available;
  $('#proStoreLink').href = storeLink();
  $('#proOwned').hidden = !s.owned;
  $('#proDialog').showModal();
}

// ---------------------------------------------------------- file import
async function importFile(file) {
  let job = activeJob();
  if (!job) { if (!allow('jobs')) return; ensureBasics(); job = newJob(state, file.name.replace(/\.(gcode|3mf|gco|g|bgcode)(\.3mf)?$/i, '')); job.prints = []; state.jobs.push(job); state.activeJobId = job.id; }
  if (/\.bgcode$/i.test(file.name)) { toast('Binary G-code (.bgcode) is not supported yet. Export plain .gcode from PrusaSlicer instead.'); return; }
  let info;
  try { info = await parseSlicedFile(file); }
  catch { toast(`Could not read ${file.name}. Is it a sliced .gcode or .gcode.3mf file?`); return; }
  if (info.grams == null && info.lengthMm == null && info.seconds == null) {
    toast(`No filament or time found in ${file.name}. Enter the slicer's numbers by hand.`);
    return;
  }
  const empty = job.prints.find((p) => !p.time && p.filaments.every((f) => !f.grams));
  const target = empty || (() => { const p = newPrint(`Print ${job.prints.length + 1}`, state.spools[0]?.id || ''); job.prints.push(p); return p; })();
  target.label = file.name.replace(/\.(gcode|gco|g)$|\.gcode\.3mf$|\.3mf$/i, '');
  target.source = file.name;
  if (info.seconds != null) target.time = C.formatDuration(info.seconds / 3600);
  // match a spool by material if the slicer names one
  let spool = state.spools.find((s) => s.id === target.filaments[0]?.spoolId);
  if (info.filamentType) {
    const byType = state.spools.find((s) => s.material.toUpperCase() === info.filamentType.toUpperCase());
    if (byType && (!spool || spool.material.toUpperCase() !== info.filamentType.toUpperCase())) spool = byType;
  }
  const grams = info.grams ?? (info.lengthMm != null ? C.gramsFromLength(info.lengthMm, diameter(spool), density(spool)) : null);
  target.filaments = [{ id: uid(), spoolId: spool?.id || '', grams: grams != null ? String(+grams.toFixed(2)) : '' }];
  touchJob(job);
  persist(true);
  state.view = 'quote';
  render();
  const what = [grams != null ? `${fmt(grams, 1)} g` : null, info.seconds != null ? C.formatDuration(info.seconds / 3600) : null].filter(Boolean).join(', ');
  toast(`Read ${what} from ${info.slicer || 'the file'}${info.grams == null && grams != null ? ' (weight worked out from length)' : ''}.`);
}

function ensureBasics() {
  if (!state.printers.length) state.printers.push(newPrinter());
  if (!state.spools.length) state.spools.push(newSpool());
}

// ------------------------------------------------------------- actions
const actions = {
  view(el) { state.view = el.dataset.view; persist(); render(); window.scrollTo(0, 0); },
  sample() {
    if (!isPro() && (state.jobs.length >= CONFIG.free.jobs)) return openPro(limitMsg('quotes', CONFIG.free.jobs));
    sampleSetup(state, { secondPrinter: isPro() || state.printers.length + 2 <= CONFIG.free.printers });
    persist(true); render();
  },
  'new-job'() {
    if (!allow('jobs')) return;
    ensureBasics();
    const j = newJob(state);
    state.jobs.push(j); state.activeJobId = j.id; state.view = 'quote';
    persist(true); render(); $('#f-j-name')?.select();
  },
  'duplicate-job'() {
    if (!allow('jobs')) return;
    const j = JSON.parse(JSON.stringify(activeJob()));
    j.id = uid(); j.name += ' (copy)'; j.printed = null; j.createdAt = j.updatedAt = new Date().toISOString();
    for (const p of j.prints) { p.id = uid(); for (const f of p.filaments) f.id = uid(); }
    for (const e of j.extras) e.id = uid();
    state.jobs.push(j); state.activeJobId = j.id; persist(true); render(); toast('Quote duplicated');
  },
  'delete-job'() {
    const j = activeJob(); const idx = state.jobs.indexOf(j);
    state.jobs.splice(idx, 1);
    state.activeJobId = [...state.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id || null;
    persist(true); render();
    undoFn = () => { state.jobs.splice(idx, 0, j); state.activeJobId = j.id; persist(true); render(); };
    toast(`Deleted ${j.name || 'quote'}`, true);
  },
  'add-print'() { const j = activeJob(); j.prints.push(newPrint(`Print ${j.prints.length + 1}`, state.spools[0]?.id || '')); touchJob(j); render(); },
  'remove-print'(el) {
    const j = activeJob(); const idx = j.prints.findIndex((p) => p.id === el.dataset.id); const [p] = j.prints.splice(idx, 1);
    touchJob(j); render(); undoFn = () => { j.prints.splice(idx, 0, p); touchJob(j); render(); }; toast(`Removed ${p.label || 'print'}`, true);
  },
  'add-filament'(el) { const j = activeJob(); const p = j.prints.find((x) => x.id === el.dataset.print); p.filaments.push(newFilamentLine(state.spools[1]?.id || state.spools[0]?.id || '')); touchJob(j); render(); },
  'remove-filament'(el) { const j = activeJob(); const p = j.prints.find((x) => x.id === el.dataset.print); p.filaments = p.filaments.filter((f) => f.id !== el.dataset.id); touchJob(j); render(); },
  'add-extra'() { const j = activeJob(); j.extras.push({ id: uid(), label: '', cost: '' }); touchJob(j); render(); $('.extra-row:last-child input')?.focus(); },
  'remove-extra'(el) { const j = activeJob(); j.extras = j.extras.filter((e) => e.id !== el.dataset.id); touchJob(j); render(); },
  'mark-printed'() {
    const j = activeJob(); const r = C.costJob(j, state);
    const used = {};
    for (const [id, g] of Object.entries(r.gramsBySpool)) {
      const sp = state.spools.find((s) => s.id === id); if (!sp) continue;
      const before = C.num(sp.remainingG) || 0;
      const take = Math.min(before, g);
      sp.remainingG = String(+(before - take).toFixed(1)); used[id] = take;
    }
    j.printed = { at: new Date().toISOString(), used };
    touchJob(j); persist(true); render();
    toast(`Took ${fmt(Object.values(used).reduce((a, b) => a + b, 0), 0)} g off your spools.`);
  },
  'unmark-printed'() {
    const j = activeJob();
    for (const [id, g] of Object.entries(j.printed?.used || {})) {
      const sp = state.spools.find((s) => s.id === id); if (sp) sp.remainingG = String(+((C.num(sp.remainingG) || 0) + g).toFixed(1));
    }
    j.printed = null; touchJob(j); persist(true); render(); toast('Filament put back on the spools.');
  },
  'add-spool'() { if (!allow('spools')) return; state.spools.push(newSpool(`Spool ${state.spools.length + 1}`)); persist(); render(); $(`.spool-card:last-of-type .spool-name`)?.select(); },
  'remove-spool'(el) {
    const idx = state.spools.findIndex((s) => s.id === el.dataset.id); const [sp] = state.spools.splice(idx, 1);
    persist(); render(); undoFn = () => { state.spools.splice(idx, 0, sp); persist(); render(); }; toast(`Removed ${sp.name || 'spool'}`, true);
  },
  'add-printer'() { if (!allow('printers')) return; state.printers.push(newPrinter(`Printer ${state.printers.length + 1}`)); persist(); render(); },
  'remove-printer'(el) {
    const idx = state.printers.findIndex((p) => p.id === el.dataset.id); const [p] = state.printers.splice(idx, 1);
    persist(); render(); undoFn = () => { state.printers.splice(idx, 0, p); persist(); render(); }; toast(`Removed ${p.name || 'printer'}`, true);
  },
  print() { $('#printArea').innerHTML = buildQuote(activeJob()); window.print(); },
  async copy() {
    try { await navigator.clipboard.writeText(summaryText(activeJob())); toast('Summary copied'); }
    catch { toast('Copying is blocked here. Use Print or save quote instead.'); }
  },
  'export-csv'() {
    if (!isPro()) return openPro('CSV export is part of Pro.');
    const j = activeJob();
    const blob = new Blob(['﻿' + csvFor(j)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${(j.name || 'spoolbook').replace(/[^\w\- ]+/g, '').trim() || 'spoolbook'}.csv`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('CSV exported');
  },
  'open-settings'() {
    const s = state.settings;
    for (const k of ['currency', 'electricityRate', 'laborRate', 'taxPct', 'feePct', 'feeFixed', 'roundTo', 'defaultFailurePct', 'defaultMarkupPct']) $(`#set-${k}`).value = s[k] ?? '';
    for (const k of ['name', 'phone', 'email', 'website']) $(`#setBiz-${k}`).value = s.business[k] || '';
    const pro = isPro();
    $('#set-feePct').disabled = !pro; $('#set-feeFixed').disabled = !pro;
    $('#feeNote').hidden = pro; $('#bizNote').hidden = pro;
    $('#settingsDialog').showModal();
  },
  'open-pro'() { openPro(); },
  async 'buy-pro'(el) {
    el.disabled = true;
    try { if (await buyPro()) { $('#proDialog').close(); toast('Spoolbook Pro is unlocked. Thank you.'); } }
    catch (e) { if (e && e.name !== 'AbortError') toast('The purchase did not go through. You have not been charged.'); }
    finally { el.disabled = false; }
  },
  async 'restore-pro'() {
    try { const owned = await restorePro(); toast(owned ? 'Pro restored' : 'No Pro purchase found for this Microsoft account.'); if (owned) $('#proDialog').close(); }
    catch { toast('Could not reach the Microsoft Store. Try again when you are online.'); }
  },
  'close-dialog'(el) { el.closest('dialog').close(); },
  undo() { if (undoFn) { undoFn(); undoFn = null; } $('#toast').classList.remove('show'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});

// ---------------------------------------------------------------- inputs
function setPath(path, value) {
  const [kind, a, b, key] = path.split('.');
  const job = activeJob();
  switch (kind) {
    case 'j': job[a] = value; touchJob(job); break;
    case 'p': job.prints.find((p) => p.id === a)[b] = value; touchJob(job); break;
    case 'f': job.prints.find((p) => p.id === a).filaments.find((f) => f.id === b)[key] = value; touchJob(job); break;
    case 'e': job.extras.find((e) => e.id === a)[b] = value; touchJob(job); break;
    case 's': state.spools.find((s) => s.id === a)[b] = value; persist(); break;
    case 'pr': state.printers.find((p) => p.id === a)[b] = value; persist(); break;
    default: break;
  }
}
main.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset.path) return;
  setPath(t.dataset.path, t.type === 'checkbox' ? t.checked : t.value);
  if (t.dataset.path === 'j.name') renderBar();
  if (state.view === 'quote' && !t.hasAttribute('data-rerender')) updateQuote();
  if (state.view !== 'quote') validate(main);
});
main.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'fileInput' && t.files[0]) { importFile(t.files[0]); return; }
  if (t.hasAttribute('data-rerender')) {
    const y = window.scrollY; const focusId = t.id;
    render(); window.scrollTo(0, y);
    if (focusId && t.type !== 'color') document.getElementById(focusId)?.focus({ preventScroll: true });
  }
});

$('#jobSelect').addEventListener('change', (e) => { state.activeJobId = e.target.value; persist(true); render(); window.scrollTo(0, 0); });

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.settings;
  for (const k of ['currency', 'electricityRate', 'laborRate', 'taxPct', 'feePct', 'feeFixed', 'roundTo', 'defaultFailurePct', 'defaultMarkupPct']) s[k] = $(`#set-${k}`).value.trim();
  for (const k of ['name', 'phone', 'email', 'website']) s.business[k] = $(`#setBiz-${k}`).value.trim();
  persist(true); $('#settingsDialog').close(); render(); toast('Settings saved');
});

// drag and drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) await importFile(f);
});

// Files opened with the app from Explorer (manifest file_handlers)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    for (const h of params.files || []) { try { await importFile(await h.getFile()); } catch { /* ignore */ } }
  });
}

window.addEventListener('beforeprint', () => { const j = activeJob(); if (j) $('#printArea').innerHTML = buildQuote(j); });

// ------------------------------------------------------------------ boot
onProChange(() => render());
if (!state.activeJobId && state.jobs.length) state.activeJobId = state.jobs[0].id;
render();
initPro().then(() => { if (new URLSearchParams(location.search).get('action') === 'new') actions['new-job'](); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});

// Exposed for tests only.
window.__spoolbook = { importFile, state };
