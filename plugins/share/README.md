# wickchart-share — the chart as a file

`exportChart()` turns a live `<wick-chart>` into **one self-contained
`.html` file**: the library's own module sources inlined, the chart's state
and bars embedded as a payload. The file opens offline in any browser and
paints the exact chart again. Only a zero-dependency, no-build library can
offer this — there is nothing else to ship.

```js
import { attachShare } from 'wickchart-share';

const share = attachShare(chart);
await share.downloadChart('btc.html');    // triggers the browser download
const html = await share.exportChart();   // …or take the string
share.detach();
```

Reading one back (host-side import, plain data out):

```js
import { parseChartFile } from 'wickchart-share';
const { bars, state, meta } = parseChartFile(await file.text());
chart.setData(bars);
chart.setState(state);
```

## How the file works

- The **core and chart modules** are embedded as base64 data-URL modules;
  the chart module's `from './core.js'` line is rewritten to the core's
  data URL at export time, so one dynamic `import()` registers the element
  with no network and no import map.
- The **payload** (`{ v, meta, state, bars }`) rides in a
  `<script type="application/json">` block, applied via `setState()` then
  `setData()` (the chart's pending-range mechanism restores the exact view).
- `<` is escaped everywhere user or source text is embedded, so neither a
  title nor a code comment can terminate a script block.

## Source discovery

The plugin finds the library's module URLs through **resource timing** —
any way the page loaded them (script tag, import map, dynamic import).
Bundled hosts have no module URLs; pass them explicitly:

```js
attachShare(chart, { coreUrl, chartUrl });          // URLs to fetch
// or hand the sources straight to the builder (Node, tests):
share.exportChart({ sources: { coreSrc, chartSrc } });
```

Peer dependency: `wickchart` ≥ 2.3. Zero dependencies, zero core changes.
The standalone builder (`buildStandaloneHTML`) and the parser
(`parseChartFile`) are pure and exported for testing.
