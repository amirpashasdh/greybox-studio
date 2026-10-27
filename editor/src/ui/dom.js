// Minimal DOM helpers: h('div.cls#id', { attrs, on: { click } }, ...children)

export function h(tag, props = {}, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9-]+)?(.*)$/i.exec(tag);
  const el = document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--name) need setProperty; Object.assign ignores them.
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// Number field that also scrubs: drag horizontally on the label to change the value.
export function numberField({ label, value, step = 0.1, min = -Infinity, max = Infinity, digits = 3, onChange, onCommit, title }) {
  const input = h('input.num', { type: 'text', inputMode: 'decimal', value: fmt(value, digits), title: title || label, 'aria-label': label });
  const lab = h('span.scrub', { title: `Drag to change ${label}` }, label);
  let startX = 0, startV = 0, dragging = false;
  const set = (v, commit) => {
    v = Math.min(max, Math.max(min, v));
    input.value = fmt(v, digits);
    (commit ? onCommit || onChange : onChange)?.(v);
  };
  lab.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startV = parseFloat(input.value) || 0;
    lab.setPointerCapture(e.pointerId);
    document.body.classList.add('is-scrubbing');
  });
  lab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    set(startV + ((e.clientX - startX) / 4) * step * mult, false);
  });
  lab.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-scrubbing');
    set(parseFloat(input.value) || 0, true);
  });
  const commit = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) set(v, true);
    else input.value = fmt(value, digits);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      set((parseFloat(input.value) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1), true);
    }
  });
  return h('label.field.numfield', lab, input);
}

export function fmt(v, digits = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const p = 10 ** digits;
  return String(Math.round(v * p) / p);
}

export function timecode(t, fps) {
  const total = Math.round(t * fps);
  const f = total % fps;
  const s = Math.floor(total / fps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function toast(message, kind = 'info', ms = 3200) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div#toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const el = h(`div.toast.${kind}`, message);
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
