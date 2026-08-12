import { t, getLang, setLang } from './strings.js';

/**
 * The two pre-map screens: a full-page intro (what this is, the model, the data) and a
 * spotlight tour over the live UI. Each shows once per browser and can be reopened from
 * the panel's 关于/教程 buttons.
 */

const seen = (k: string) => localStorage.getItem(k) === '1';
const mark = (k: string) => localStorage.setItem(k, '1');

// The intro has its own language toggle but renders before the main UI exists, so the
// main script registers its applyStrings here once the panel is ready to relocalize.
let relocalize: () => void = () => {};
export function onRelocalize(fn: () => void) { relocalize = fn; }

export function showIntro(): Promise<void> {
  document.getElementById('intro')?.remove();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'intro';

    const uses = [
      ['🚗', 'introUseDrivingTitle', 'introUseDriving'],
      ['🏠', 'introUsePreventTitle', 'introUsePrevent'],
      ['🛵', 'introUseTakeoutTitle', 'introUseTakeout'],
    ] as const;
    const sources: [Parameters<typeof t>[0], Parameters<typeof t>[0], string | null][] = [
      ['introDataRainTitle', 'introDataRain', 'https://docs.caiyunapp.com/weather-api/'],
      ['introDataTerrainTitle', 'introDataTerrain', 'https://registry.opendata.aws/copernicus-dem/'],
      ['introDataBasemapTitle', 'introDataBasemap', null],
    ];

    // All interpolated text is our own dict, never user or network data, so innerHTML is safe.
    const render = () => {
      // The language toggle re-renders the whole card; keep the disclosure as the user left it.
      const detailsOpen = root.querySelector<HTMLDetailsElement>('.intro-details')?.open ?? false;
      root.innerHTML = `
        <div class="intro-card">
          <div class="intro-top">
            <h1>${t('title')}</h1>
            <button id="introLang">${t('langToggle')}</button>
          </div>
          <p class="intro-tagline">${t('introTagline')}</p>

          <h2>${t('introUsesHeading')}</h2>
          <div class="intro-uses">
            ${uses.map(([emoji, title, body]) => `
              <div class="intro-use"><span class="emoji">${emoji}</span>
                <strong>${t(title)}</strong>${t(body)}</div>`).join('')}
          </div>

          <details class="intro-details"${detailsOpen ? ' open' : ''}>
            <summary>${t('introDetailsSummary')}</summary>

            <h2>${t('introModelHeading')}</h2>
            <p class="intro-body">${t('introModelIntro')}</p>
            <pre class="intro-formula">${t('fmLine1')}\n${t('fmLine2')}\n${t('fmLine3')}</pre>
            <ul class="intro-notes">
              <li>${t('fmNote1')}</li>
              <li>${t('fmNote2')}</li>
              <li>${t('fmNote3')}</li>
            </ul>

            <h2>${t('introDataHeading')}</h2>
            ${sources.map(([title, body, url]) => `
              <div class="intro-source">
                <strong>${t(title)}</strong>
                ${url ? `<a href="${url}" target="_blank" rel="noopener">${t('introDocsLink')}</a>` : ''}
                <p>${t(body)}</p>
              </div>`).join('')}
          </details>

          <p class="intro-disclaimer">⚠️ ${t('introDisclaimer')}</p>
          <button class="intro-start">${t('introStart')}</button>
        </div>`;
      root.querySelector('#introLang')!.addEventListener('click', () => {
        setLang(getLang() === 'zh' ? 'en' : 'zh');
        render();
        relocalize();
      });
      root.querySelector('.intro-start')!.addEventListener('click', () => {
        mark('seenIntro');
        root.remove();
        resolve();
      });
    };
    render();
    document.body.append(root);
  });
}

interface Step { sel: string | null; key: Parameters<typeof t>[0]; }
const STEPS: Step[] = [
  { sel: null, key: 'tourMap' }, // null spotlights the middle of the map itself
  { sel: '#city', key: 'tourCity' },
  { sel: '#drainage', key: 'tourDrainage' },
  { sel: '#legend', key: 'tourLegend' },
  { sel: '#showElevation', key: 'tourElevation' },
  { sel: '#timebar', key: 'tourTime' },
];

export function startTour(): void {
  document.getElementById('tour')?.remove();
  const root = document.createElement('div');
  root.id = 'tour';
  const dim = document.createElement('div');
  dim.className = 'tour-dim';
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const card = document.createElement('div');
  card.className = 'tour-card';
  root.append(dim, spot, card);
  document.body.append(root);
  let i = 0;

  const rectFor = (s: Step) => {
    if (!s.sel) {
      const w = Math.min(innerWidth, innerHeight) * 0.5;
      return { left: (innerWidth - w) / 2, top: (innerHeight - w * 0.7) / 2, width: w, height: w * 0.7 };
    }
    const el = document.querySelector(s.sel)!;
    // Sliders and checkboxes sit inside their <label>, so highlight the label to keep
    // the caption inside the ring rather than cutting it in half.
    return (el.closest('label') ?? el).getBoundingClientRect();
  };

  // The viewport rect plus a counter-traced rounded hole; the even-odd rule clears the hole.
  const dimPath = (x: number, y: number, w: number, h: number) => {
    const r = 10;
    return `path(evenodd, "M0 0H${innerWidth}V${innerHeight}H0Z \
M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}\
A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}\
V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`;
  };

  const place = () => {
    const r = rectFor(STEPS[i]);
    const pad = 8;
    Object.assign(spot.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
    dim.style.clipPath = dimPath(r.left - pad, r.top - pad, r.width + pad * 2, r.height + pad * 2);
    const last = i === STEPS.length - 1;
    card.innerHTML = `
      <p>${t(STEPS[i].key)}</p>
      <div class="tour-nav">
        <span class="tour-meta">${i + 1}/${STEPS.length}${last ? '' : ` · <button data-a="skip">${t('tourSkip')}</button>`}</span>
        <span>
          ${i > 0 ? `<button data-a="prev">${t('tourPrev')}</button>` : ''}
          <button data-a="next" class="primary">${last ? t('tourDone') : t('tourNext')}</button>
        </span>
      </div>`;
    // Prefer beside the spotlight (the panel hugs the left edge), else below, else above.
    const gap = 14;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let left = r.left + r.width + pad + gap;
    let top = r.top;
    if (left + cw > innerWidth - 8) {
      left = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), innerWidth - cw - 8);
      top = r.top + r.height + pad + gap;
      if (top + ch > innerHeight - 8) top = r.top - pad - gap - ch;
    }
    card.style.left = `${left}px`;
    card.style.top = `${Math.min(Math.max(8, top), innerHeight - ch - 8)}px`;
  };

  const end = () => {
    mark('seenTour');
    root.remove();
    removeEventListener('resize', place);
    removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); };

  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    if (a === 'next') (i === STEPS.length - 1) ? end() : (i++, place());
    else if (a === 'prev') { i--; place(); }
    else if (a === 'skip') end();
  });
  addEventListener('resize', place);
  addEventListener('keydown', onKey);
  place();
}

export const maybeShowIntro = () => (seen('seenIntro') ? Promise.resolve() : showIntro());
export const maybeStartTour = () => { if (!seen('seenTour')) startTour(); };
