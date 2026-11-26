// Traffic analytics panel (site-wide page + artifact detail card). Zero external deps; strict CSP compatible.
import { errorText, locale, t } from './i18n.js';
import { h } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RANGES = ['24h', '7d', '30d', '90d'];
let chartUid = 0;

const compactMedia = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
const compactPanels = new Set();
const panelHolders = new WeakMap();

function pruneCompactPanels(notify = false) {
  for (const ref of compactPanels) {
    const entry = typeof ref.deref === 'function' ? ref.deref() : ref;
    if (!entry || entry.isPrunable()) {
      entry?.cleanup();
      compactPanels.delete(ref);
    } else if (notify) {
      entry.onChange();
    }
  }
}

compactMedia?.addEventListener?.('change', () => pruneCompactPanels(true));

function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString(locale());
}

function browserTzMinutes() {
  const off = -new Date().getTimezoneOffset() || 0;
  return Math.max(-720, Math.min(840, Math.trunc(off)));
}

let regionFormatterKey = '';
let regionFormatter = null;
function regionName(code) {
  if (!code) return '';
  const loc = locale();
  if (regionFormatterKey !== loc) {
    regionFormatterKey = loc;
    try {
      regionFormatter = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([loc], { type: 'region' }) : null;
    } catch {
      regionFormatter = null;
    }
  }
  try {
    return regionFormatter?.of(code) || code;
  } catch {
    return code;
  }
}

function niceScale(maxVal) {
  if (maxVal <= 3) return { top: 3, ticks: [0, 1, 2, 3] };
  const rawStep = maxVal / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = mult * pow;
  const top = Math.ceil(maxVal / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.01; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

/** Fritsch-Carlson monotone cubic spline; stays smooth without overshooting below the zero baseline. */
function monotoneLine(points, yBase) {
  const n = points.length;
  if (!n) return '';
  if (n === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  if (n === 2) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}L${points[1].x.toFixed(2)},${points[1].y.toFixed(2)}`;

  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const m = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    dy[i] = points[i + 1].y - points[i].y;
    m[i] = dx[i] ? dy[i] / dx[i] : 0;
  }

  const d = new Array(n);
  d[0] = m[0];
  d[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      d[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      d[i] = 0;
      d[i + 1] = 0;
    } else {
      const a = d[i] / m[i];
      const b = d[i + 1] / m[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        d[i] = tau * a * m[i];
        d[i + 1] = tau * b * m[i];
      }
    }
  }

  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    const c1x = points[i].x + seg;
    const c1y = Math.min(yBase, points[i].y + d[i] * seg);
    const c2x = points[i + 1].x - seg;
    const c2y = Math.min(yBase, points[i + 1].y - d[i + 1] * seg);
    path += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${points[i + 1].x.toFixed(2)},${points[i + 1].y.toFixed(2)}`;
  }
  return path;
}

function areaFromLine(linePath, points, yBase) {
  if (!points.length) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath}L${last.x.toFixed(2)},${yBase.toFixed(2)}L${first.x.toFixed(2)},${yBase.toFixed(2)}Z`;
}

let dateFormattersLocale = '';
let dateFormatters = null;
function getDateFormatters() {
  const loc = locale();
  if (dateFormattersLocale !== loc || !dateFormatters) {
    dateFormattersLocale = loc;
    dateFormatters = {
      axisDay: new Intl.DateTimeFormat(loc, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }),
      tipHour: new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      tipDay: new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' }),
    };
  }
  return dateFormatters;
}

function formatBucketAxis(ts, bucket, tzMin) {
  const d = new Date((ts + tzMin * 60) * 1000);
  if (bucket === 'hour') {
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return `${hh}:00`;
  }
  return getDateFormatters().axisDay.format(d);
}

function formatBucketTooltip(ts, bucket, tzMin) {
  const d = new Date((ts + tzMin * 60) * 1000);
  if (bucket === 'hour') {
    const datePart = getDateFormatters().tipHour.format(d);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return `${datePart} ${hh}:00`;
  }
  return getDateFormatters().tipDay.format(d);
}

function pickLabelIndices(n, plotW, compact) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const minGap = compact ? 56 : 70;
  const maxLabels = Math.max(2, Math.floor(plotW / minGap) + 1);
  if (n <= maxLabels) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (maxLabels - 1));
  const indices = [];
  for (let i = 0; i < n; i += step) indices.push(i);
  if (indices[indices.length - 1] !== n - 1) {
    const last = indices[indices.length - 1];
    const minLastIdxGap = (plotW / (n - 1)) * (n - 1 - last);
    if (minLastIdxGap < minGap * 0.75) indices[indices.length - 1] = n - 1;
    else indices.push(n - 1);
  }
  return indices;
}

function fmtCompactTick(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return String(v);
}

function renderBarCard(title, rows, formatLabel) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  const body = rows.length
    ? h(
        'div',
        { class: 'an-bars' },
        rows.map((r) => {
          const label = formatLabel(r.key);
          const fill = h('div', { class: 'an-bar-fill' });
          fill.style.width = `${Math.max(4, Math.round((r.count / max) * 100))}%`;
          return h(
            'div',
            { class: 'an-bar-row' },
            h(
              'div',
              { class: 'an-bar-head' },
              h('span', { class: 'an-bar-label', title: label }, label),
              h('span', { class: 'an-bar-val' }, fmtNum(r.count)),
            ),
            h('div', { class: 'an-bar-track' }, fill),
          );
        }),
      )
    : h('p', { class: 'muted small an-none' }, t('analytics.noData'));
  return h('div', { class: 'card an-card' }, h('h2', {}, title), body);
}

function renderTopArtifactsCard(items, onNavigateArtifact) {
  const body = items.length
    ? h(
        'div',
        { class: 'an-rank-list' },
        items.map((item, idx) => {
          const titleText = item.title || t('common.untitled');
          const kindLabel = item.kind ? (item.kind === 'folder' ? t('detail.kindFolder') : t(item.kind === 'markdown' ? 'detail.kindMarkdown' : 'detail.kindHtml')) : null;
          const visLabel = item.visibility ? t(`vis.${item.visibility}`) : null;
          const meta = [kindLabel, visLabel, item.deleted ? t('analytics.deleted') : null].filter(Boolean).join(' · ');
          const content = [
            h('span', { class: 'an-rank-num' }, String(idx + 1)),
            h(
              'div',
              { class: 'an-rank-main' },
              h('div', { class: 'an-rank-title', title: titleText }, titleText),
              h('div', { class: 'an-rank-meta muted small' }, meta),
            ),
            h(
              'div',
              { class: 'an-rank-nums' },
              h('span', { class: 'an-rank-pv' }, t('analytics.pvShort', { n: fmtNum(item.views) })),
              h('span', { class: 'an-rank-uv muted small' }, t('analytics.uvShort', { n: fmtNum(item.visitors) })),
            ),
          ];
          if (item.deleted) {
            return h('div', { class: 'an-rank-row is-deleted' }, content);
          }
          return h(
            'button',
            { type: 'button', class: 'an-rank-row is-link', onclick: () => onNavigateArtifact?.(item.id) },
            content,
          );
        }),
      )
    : h('p', { class: 'muted small an-none' }, t('analytics.noData'));

  return h('div', { class: 'card an-card an-top-card' }, h('h2', {}, t('analytics.topArtifacts')), body);
}

export function createAnalyticsPanel({ api, artifactId = null, kind = null, onNavigateArtifact = null, onRangeChange = null }) {
  let range = '7d';
  let includeBots = false;
  let showPv = true;
  let showUv = true;
  let seq = 0;
  let lastData = null;
  let everConnected = false;
  let cleanupChart = null;
  const tzMin = browserTzMinutes();

  const segBtns = {};
  const seg = h(
    'div',
    { class: 'seg an-seg' },
    RANGES.map((r) => {
      const btn = h(
        'button',
        {
          type: 'button',
          class: r === range ? 'on' : '',
          onclick: () => {
            if (range === r) return;
            range = r;
            for (const [k, el] of Object.entries(segBtns)) el.classList.toggle('on', k === r);
            onRangeChange?.(r);
            load();
          },
        },
        t(`analytics.range.${r}`),
      );
      segBtns[r] = btn;
      return btn;
    }),
  );

  const botsCheck = h('input', {
    type: 'checkbox',
    checked: includeBots,
    onchange: () => {
      includeBots = botsCheck.checked;
      load();
    },
  });
  const controls = h('div', { class: 'an-controls' }, seg, h('label', { class: 'check an-bots' }, botsCheck, t('analytics.includeBots')));
  const root = h('div', { class: 'stack an-panel' });

  function renderData(data) {
    if (root.isConnected) everConnected = true;
    cleanupChart?.();
    cleanupChart = null;
    lastData = data;
    const totals = data.totals || { views: 0, visitors: 0, downloads: 0, views_90d: 0 };

    const kpis = h(
      'div',
      { class: 'an-kpis' },
      h('div', { class: 'card an-kpi' }, h('div', { class: 'an-kpi-k' }, t('analytics.kpi.views')), h('div', { class: 'an-kpi-v' }, fmtNum(totals.views))),
      h('div', { class: 'card an-kpi' }, h('div', { class: 'an-kpi-k' }, t('analytics.kpi.visitors')), h('div', { class: 'an-kpi-v' }, fmtNum(totals.visitors))),
      h('div', { class: 'card an-kpi' }, h('div', { class: 'an-kpi-k' }, t('analytics.kpi.downloads')), h('div', { class: 'an-kpi-v' }, fmtNum(totals.downloads))),
    );

    const chartCard = buildChartCard(data);

    const breakdownCards = [
      renderBarCard(
        t('analytics.referrers'),
        (data.referrers || []).map((r) => ({ key: r.host, count: r.count })),
        (host) => (host === 'direct' ? t('analytics.direct') : host),
      ),
      renderBarCard(
        t('analytics.countries'),
        (data.countries || []).map((c) => ({ key: c.code, count: c.views })),
        regionName,
      ),
      renderBarCard(
        t('analytics.devices'),
        (data.devices || []).map((d) => ({ key: d.type, count: d.views })),
        (type) => t(`analytics.device.${type}`),
      ),
    ];
    if (artifactId && kind === 'folder') {
      breakdownCards.push(
        renderBarCard(
          t('analytics.paths'),
          (data.paths || []).map((p) => ({ key: p.path, count: p.views })),
          (p) => p,
        ),
      );
    }

    const gridClass = artifactId && kind === 'folder' ? 'an-grid an-grid-2' : 'an-grid';
    const topCard = !artifactId ? renderTopArtifactsCard(data.top_artifacts || [], onNavigateArtifact) : null;

    root.replaceChildren(...[kpis, chartCard, topCard, h('div', { class: gridClass }, breakdownCards)].filter(Boolean));
  }

  function buildChartCard(data) {
    const pvPill = h(
      'button',
      {
        type: 'button',
        class: `an-pill is-pv ${showPv ? 'on' : ''}`,
        title: t('analytics.isolateHint'),
        'aria-pressed': String(showPv),
        onclick: () => {
          if (showPv && !showUv) return;
          showPv = !showPv;
          if (lastData) renderData(lastData);
        },
      },
      h('span', { class: 'an-dot pv' }),
      t('analytics.series.views'),
    );
    const uvPill = h(
      'button',
      {
        type: 'button',
        class: `an-pill is-uv ${showUv ? 'on' : ''}`,
        title: t('analytics.isolateHint'),
        'aria-pressed': String(showUv),
        onclick: () => {
          if (showUv && !showPv) return;
          showUv = !showUv;
          if (lastData) renderData(lastData);
        },
      },
      h('span', { class: 'an-dot uv' }),
      t('analytics.series.visitors'),
    );

    const legendHint = showPv && showUv ? h('span', { class: 'an-legend-hint muted' }, t('analytics.isolateHint')) : null;
    const hintParts = [];
    if (!showPv && showUv) hintParts.push(t('analytics.scaledUv'));
    if (data.range === '90d') hintParts.push(t('analytics.window90d'));
    else hintParts.push(t('analytics.views90d', { n: fmtNum(data.totals?.views_90d ?? 0) }));
    const legendMeta = h('span', { class: 'muted small an-legend-meta' }, hintParts.join(' · '));
    const legend = h('div', { class: 'an-legend' }, h('div', { class: 'an-pills' }, pvPill, uvPill, legendHint), legendMeta);

    const series = data.series || [];
    const hasValues = series.some((p) => p.views > 0 || p.visitors > 0);
    if (!hasValues || !series.length) {
      const emptyMsg = data.dataset_missing ? t('analytics.datasetMissing') : t('analytics.empty');
      return h('div', { class: 'card an-card an-chart-card' }, legend, h('div', { class: 'an-chart-empty muted' }, emptyMsg));
    }

    const compact = compactMedia ? compactMedia.matches : window.innerWidth <= 640;
    const W = compact ? 340 : 720;
    const H = compact ? 156 : 220;
    const pad = compact ? { top: 12, right: 10, bottom: 26, left: 34 } : { top: 14, right: 14, bottom: 28, left: 42 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const yBase = pad.top + plotH;

    const maxActive = Math.max(
      1,
      ...series.map((p) => Math.max(showPv ? p.views : 0, showUv ? p.visitors : 0)),
    );
    const { top, ticks } = niceScale(maxActive);
    const xAt = (i) => (series.length === 1 ? pad.left + plotW / 2 : pad.left + (i / (series.length - 1)) * plotW);
    const yAt = (v) => yBase - (Math.max(0, v) / top) * plotH;

    const uid = ++chartUid;
    const pvGradId = `an-pv-grad-${uid}`;
    const uvGradId = `an-uv-grad-${uid}`;

    const defs = svgEl(
      'defs',
      {},
      svgEl(
        'linearGradient',
        { id: pvGradId, x1: '0', y1: '0', x2: '0', y2: '1' },
        svgEl('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.22' }),
        svgEl('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.01' }),
      ),
      svgEl(
        'linearGradient',
        { id: uvGradId, x1: '0', y1: '0', x2: '0', y2: '1' },
        svgEl('stop', { offset: '0%', 'stop-color': 'var(--uv)', 'stop-opacity': '0.18' }),
        svgEl('stop', { offset: '100%', 'stop-color': 'var(--uv)', 'stop-opacity': '0.01' }),
      ),
    );

    const gridGroup = svgEl('g', { class: 'an-gridlines' });
    for (const tick of ticks) {
      const y = yAt(tick);
      gridGroup.append(
        svgEl('line', { x1: pad.left, y1: y.toFixed(2), x2: W - pad.right, y2: y.toFixed(2), class: tick === 0 ? 'an-axis-line' : 'an-grid-line' }),
        svgEl('text', { x: pad.left - 6, y: (y + 3.5).toFixed(2), 'text-anchor': 'end', class: 'an-axis-text' }, fmtCompactTick(tick)),
      );
    }

    const labelIndices = pickLabelIndices(series.length, plotW, compact);
    const xGroup = svgEl('g', { class: 'an-xlabels' });
    for (const idx of labelIndices) {
      const x = xAt(idx);
      const anchor = idx === 0 ? 'start' : idx === series.length - 1 ? 'end' : 'middle';
      xGroup.append(
        svgEl('text', { x: x.toFixed(2), y: H - 6, 'text-anchor': anchor, class: 'an-axis-text' }, formatBucketAxis(series[idx].ts, data.bucket, tzMin)),
      );
    }

    const pvPoints = series.map((p, i) => ({ x: xAt(i), y: yAt(p.views) }));
    const uvPoints = series.map((p, i) => ({ x: xAt(i), y: yAt(p.visitors) }));

    const seriesGroup = svgEl('g');
    if (showPv) {
      const pvLine = monotoneLine(pvPoints, yBase);
      seriesGroup.append(
        svgEl('path', { d: areaFromLine(pvLine, pvPoints, yBase), fill: `url(#${pvGradId})` }),
        svgEl('path', { d: pvLine, fill: 'none', stroke: 'var(--accent)', 'stroke-width': compact ? '2' : '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
    }
    if (showUv) {
      const uvLine = monotoneLine(uvPoints, yBase);
      seriesGroup.append(
        svgEl('path', { d: areaFromLine(uvLine, uvPoints, yBase), fill: `url(#${uvGradId})` }),
        svgEl('path', { d: uvLine, fill: 'none', stroke: 'var(--uv)', 'stroke-width': compact ? '2' : '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
    }

    const crosshair = svgEl('line', { x1: 0, y1: pad.top, x2: 0, y2: yBase, class: 'an-crosshair', hidden: 'true' });
    const pvMarker = svgEl('circle', { cx: 0, cy: 0, r: compact ? '4' : '4.5', class: 'an-marker pv', hidden: 'true' });
    const uvMarker = svgEl('circle', { cx: 0, cy: 0, r: compact ? '4' : '4.5', class: 'an-marker uv', hidden: 'true' });

    const svg = svgEl(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, class: 'an-svg', role: 'img', 'aria-label': t('analytics.title') },
      defs,
      gridGroup,
      xGroup,
      seriesGroup,
      crosshair,
      pvMarker,
      uvMarker,
    );

    const tooltip = h('div', { class: 'an-tooltip', hidden: true });
    const stage = h('div', { class: 'an-chart-stage' }, svg, tooltip);

    let activeIdx = null;
    function onDocPointerDown(e) {
      if (!stage.contains(e.target)) hideHover();
    }
    function hideHover() {
      activeIdx = null;
      crosshair.setAttribute('hidden', 'true');
      pvMarker.setAttribute('hidden', 'true');
      uvMarker.setAttribute('hidden', 'true');
      tooltip.hidden = true;
      document.removeEventListener('pointerdown', onDocPointerDown);
    }
    cleanupChart = hideHover;

    function showAtClientX(clientX, isTouch) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const svgX = ((clientX - rect.left) / rect.width) * W;
      const idx =
        series.length === 1
          ? 0
          : Math.max(0, Math.min(series.length - 1, Math.round(((svgX - pad.left) / plotW) * (series.length - 1))));
      if (isTouch && activeIdx === idx && !tooltip.hidden) {
        hideHover();
        return;
      }
      if (!isTouch && activeIdx === idx && !tooltip.hidden) return;
      activeIdx = idx;
      const pt = series[idx];
      const cx = xAt(idx);

      crosshair.setAttribute('x1', cx.toFixed(2));
      crosshair.setAttribute('x2', cx.toFixed(2));
      crosshair.removeAttribute('hidden');

      if (showPv) {
        pvMarker.setAttribute('cx', pvPoints[idx].x.toFixed(2));
        pvMarker.setAttribute('cy', pvPoints[idx].y.toFixed(2));
        pvMarker.removeAttribute('hidden');
      } else {
        pvMarker.setAttribute('hidden', 'true');
      }

      if (showUv) {
        uvMarker.setAttribute('cx', uvPoints[idx].x.toFixed(2));
        uvMarker.setAttribute('cy', uvPoints[idx].y.toFixed(2));
        uvMarker.removeAttribute('hidden');
      } else {
        uvMarker.setAttribute('hidden', 'true');
      }

      const tipRows = [h('div', { class: 'an-tip-date' }, formatBucketTooltip(pt.ts, data.bucket, tzMin))];
      if (showPv) {
        tipRows.push(h('div', { class: 'an-tip-row' }, h('span', { class: 'an-dot pv' }), h('span', {}, t('analytics.series.views')), h('strong', {}, fmtNum(pt.views))));
      }
      if (showUv) {
        tipRows.push(h('div', { class: 'an-tip-row' }, h('span', { class: 'an-dot uv' }), h('span', {}, t('analytics.series.visitors')), h('strong', {}, fmtNum(pt.visitors))));
      }
      if (pt.downloads > 0) {
        tipRows.push(h('div', { class: 'an-tip-row' }, h('span', { class: 'an-dot dl' }), h('span', {}, t('analytics.series.downloads')), h('strong', {}, fmtNum(pt.downloads))));
      }
      tooltip.replaceChildren(...tipRows);
      tooltip.hidden = false;

      const stageRect = stage.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;
      const tipW = tooltip.offsetWidth || 140;
      const left = Math.max(4, Math.min(stageRect.width - tipW - 4, pxX > stageRect.width * 0.6 ? pxX - tipW - 10 : pxX + 10));
      tooltip.style.left = `${Math.round(left)}px`;
      if (isTouch) document.addEventListener('pointerdown', onDocPointerDown);
    }

    svg.addEventListener('pointerdown', (e) => showAtClientX(e.clientX, e.pointerType === 'touch'));
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      showAtClientX(e.clientX, false);
    });
    stage.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      hideHover();
    });

    return h('div', { class: 'card an-card an-chart-card' }, legend, stage);
  }

  pruneCompactPanels(false);
  const compactEntry = {
    isPrunable: () => everConnected && !root.isConnected,
    cleanup: () => {
      cleanupChart?.();
      cleanupChart = null;
    },
    onChange: () => {
      if (root.isConnected) everConnected = true;
      if (lastData && root.isConnected) renderData(lastData);
    },
  };
  if (compactMedia) {
    panelHolders.set(root, compactEntry);
    compactPanels.add(typeof WeakRef === 'function' ? new WeakRef(compactEntry) : compactEntry);
  }

  async function load() {
    if (root.isConnected) everConnected = true;
    cleanupChart?.();
    cleanupChart = null;
    const mine = ++seq;
    root.replaceChildren(h('p', { class: 'muted small an-loading' }, t('analytics.loading')));
    try {
      const base = artifactId ? `/api/v1/artifacts/${artifactId}/analytics` : '/api/v1/analytics';
      const qs = new URLSearchParams({ range, tz: String(tzMin), bots: includeBots ? '1' : '0' });
      const data = await api('GET', `${base}?${qs}`);
      if (mine !== seq) return;
      if (!data?.enabled) {
        root.replaceChildren(h('p', { class: 'muted small an-none' }, t('analytics.empty')));
        return;
      }
      renderData(data);
    } catch (e) {
      if (mine !== seq) return;
      const retry = h('button', { type: 'button', class: 'sm', onclick: () => load() }, t('analytics.retry'));
      const msg = errorText(e?.code, e?.message || t('analytics.loadFailed'), e?.details);
      root.replaceChildren(
        h('div', { class: 'card an-error' }, h('p', { class: 'err' }, msg || t('analytics.loadFailed')), retry),
      );
    }
  }

  return {
    root,
    controls,
    load,
    getRange: () => range,
  };
}
