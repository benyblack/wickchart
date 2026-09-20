// i18n string packs + the preset attribute (the 2.1 polish track's
// Track-5 S-items). Packs: built-in en/de, host registration with English
// fallback for untranslated keys, unknown lang → en. Preset: a chrome
// starting point that explicit attributes override.
// (Named i18n-preset at write time; renamed to the prNN convention when
// the batch PR number is known — see docs/decisions/2.1.0-polish-track.md.)
import test from 'node:test';
import assert from 'node:assert/strict';

const { WickChart } = await import('../src/wick-chart.js');
const P = WickChart.prototype;

test('built-in packs cover every key the render path reads', () => {
  const keys = [
    'noData', 'chart', 'last', 'percent', 'bars',
    'ret', 'maxDD', 'annVol', 'up', 'dn', 'vol',
  ];
  for (const lang of ['en', 'de']) {
    const pack = WickChart.STRINGS[lang];
    for (const k of keys) {
      assert.equal(typeof pack[k], 'string', `${lang}.${k} present`);
      assert.ok(pack[k].length > 0, `${lang}.${k} non-empty`);
    }
  }
});

test('registerStrings merges over English and creates new languages', () => {
  WickChart.registerStrings('fr', { noData: 'Aucune donnée', bars: 'bougies' });
  const fr = WickChart.STRINGS.fr;
  assert.equal(fr.noData, 'Aucune donnée'); // overridden
  assert.equal(fr.bars, 'bougies');
  assert.equal(fr.maxDD, WickChart.STRINGS.en.maxDD); // fallback key
  // partial pack on an existing language merges, does not replace
  WickChart.registerStrings('fr', { vol: 'volume' });
  assert.equal(WickChart.STRINGS.fr.noData, 'Aucune donnée');
  assert.equal(WickChart.STRINGS.fr.vol, 'volume');
  // junk is rejected, not stored
  WickChart.registerStrings('', { noData: 'x' });
  WickChart.registerStrings(null, { noData: 'x' });
  assert.equal(WickChart.STRINGS[''], undefined);
});

test('preset minimal/pro set the chrome without overriding explicit attributes', () => {
  const make = (attrs) => {
    const c = {
      _stats: false,
      _statsKey: '',
      _ind: { overlays: [], panes: [], volume: true },
      _legend: { style: {} },
      _preset: null,
      hasAttribute: (a) => Object.prototype.hasOwnProperty.call(attrs, a),
      // explicit attribute values as attributeChangedCallback would set them
      _stats: attrs.stats === 'on',
    };
    c._applyPreset = P._applyPreset.bind(c);
    return c;
  };

  const minimal = make({});
  minimal._preset = 'minimal';
  minimal._applyPreset();
  assert.equal(minimal._stats, false);
  assert.equal(minimal._ind.volume, false);
  assert.equal(minimal._legend.style.display, 'none');

  const pro = make({});
  pro._preset = 'pro';
  pro._applyPreset();
  assert.equal(pro._stats, true);
  assert.equal(pro._ind.volume, true);
  assert.equal(pro._legend.style.display, '');

  // explicit stats stays explicit even under preset=pro
  const explicit = make({ stats: 'off' });
  explicit._preset = 'pro';
  explicit._applyPreset();
  assert.equal(explicit._stats, false);

  // removing the preset restores the legend
  const cleared = make({});
  cleared._preset = null;
  cleared._applyPreset();
  assert.equal(cleared._legend.style.display, '');

  // junk values fall out of the branch that hides anything — default chrome
  const junk = make({});
  junk._preset = 'deluxe';
  junk._applyPreset();
  assert.equal(junk._legend.style.display, ''); // default, nothing hidden
  assert.equal(junk._ind.volume, true); // untouched, unlike minimal
});
