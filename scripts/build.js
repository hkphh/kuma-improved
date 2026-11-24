#!/usr/bin/env node
/**
 * Сборка расширения KUMA Improved для Chromium и Firefox.
 *
 *   node scripts/build.js              # обе сборки
 *   node scripts/build.js --chromium   # только Chromium
 *   node scripts/build.js --firefox    # только Firefox
 *
 * Chromium собирается как есть: исходники в корне проекта — рабочий
 * распакованный extension (manifest_version 3, service_worker).
 *
 * Firefox получает свою копию в dist/firefox:
 *   - тот же manifest_version 3 (Firefox 109+), но вместо service_worker
 *     указывается background.scripts — в Firefox фон MV3 не поддерживает
 *     ES-модули, а service-worker.js использует import;
 *   - чтобы код не расходился, service-worker.js объединяется со своими
 *     зависимостями обычным скриптом (bundle) — см. scripts/bundle-background.js;
 *   - chrome.* заменяется не нужно: Firefox поддерживает namespace chrome
 *     в MV3 (обещания тоже).
 *
 * Результат: dist/kuma-improved-<version>-chromium.zip и -firefox.zip
 * (Firefox-сборка также пригодна для «Загрузить временное дополнение»).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const banner = '';

/**
 * Firefox поддерживает chrome.* и в MV3, но некоторые вызовы удобнее через
 * browser.* (обещания + отмена). Объявляем browser как алиас, если его нет.
 */
const POLYFILL = `/* browser.* = chrome.* (если браузер не предоставил свой) */\n` +
  `if (typeof browser === 'undefined') { var browser = chrome; }`;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

/* ----------------------------- общие утилиты ----------------------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(from, to, filter) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    ensureDir(to);
    for (const entry of fs.readdirSync(from)) {
      const src = path.join(from, entry);
      const dst = path.join(to, entry);
      if (filter && !filter(src)) continue;
      copyRecursive(src, dst, filter);
    }
    return;
  }
  fs.copyFileSync(from, to);
}

/** Что не попадает в сборку: сам dist, скрипты разработки, служебные файлы. */
function skipForBuild(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  if (rel === 'dist' || rel.startsWith('dist/')) return true;
  if (rel === 'scripts' || rel.startsWith('scripts/')) return true;
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return true;
  if (rel === '.DS_Store' || rel.endsWith('/.DS_Store')) return true;
  return false;
}

function zip(dir, outFile) {
  fs.rmSync(outFile, { force: true });
  execFileSync('zip', ['-rq', outFile, '.'], { cwd: dir, stdio: 'inherit' });
  return outFile;
}

/* -------------------------------- Chromium -------------------------------- */

function buildChromium() {
  const outDir = path.join(DIST, 'chromium');
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  copyRecursive(ROOT, outDir, (src) => !skipForBuild(src));

  const out = zip(outDir, path.join(DIST, `kuma-improved-${version}-chromium.zip`));
  console.log(`[chromium] ${path.relative(ROOT, outDir)} -> ${path.relative(ROOT, out)}`);
}

/* --------------------------------- Firefox -------------------------------- */

/**
 * В Firefox MV3 фон — обычный скрипт (ES-модули не поддерживаются), а
 * страницы вроде options и popup грузят ES-модули, но не могут импортировать
 * файлы вне своей папки. Поэтому для каждой точки входа собираем один
 * самодостаточный файл: импортируемый модуль подставляется в начало, а из
 * импорта остаются только имена.
 */
function bundleOne(outFile, { entry, imports }) {
  let source = fs.readFileSync(entry, 'utf8');
  const parts = [];

  for (const { rel, file, names } of imports) {
    let mod = fs.readFileSync(file, 'utf8');
    mod = mod
      .replace(/^export\s+(const|let|var|function|async function|class)\s/gm, '$1 ')
      .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
      .replace(/^\s*export\s+default\s+/gm, 'var __default = ');
    parts.push(`/* ---- ${rel} ---- */\n${mod}`);

    // Ищем именно импорт с этим путём: {…} может занимать несколько строк.
    const importRe = /import\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"];?/g;
    let replaced = false;
    source = source.replace(importRe, (all, spec) => {
      if (spec !== rel) return all;
      replaced = true;
      return `/* ${rel} подставлен выше (${names.length}) */`;
    });
    if (!replaced) throw new Error(`${path.relative(ROOT, entry)}: не найден импорт ${rel}`);
  }

  const bundled = [
    banner,
    '/* Сгенерировано scripts/build.js — сборка для Firefox. Не редактировать. */',
    '(function () {',
    '"use strict";',
    '',
    POLYFILL,
    '',
    ...parts,
    '',
    `/* ---- ${path.relative(ROOT, entry).split(path.sep).join('/')} ---- */`,
    source,
    '})();',
    ''
  ].join('\n');

  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, bundled);
  return outFile;
}

function bundledImports(entryRel) {
  const source = fs.readFileSync(path.join(ROOT, entryRel), 'utf8');
  const found = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g;
  let m;
  while ((m = re.exec(source))) {
    found.push({
      // rel — путь как в импорте (по нему заменяем строку), file — от корня.
      rel: m[2],
      file: path.join(ROOT, path.posix.normalize(path.posix.join(path.posix.dirname(entryRel), m[2]))),
      names: m[1].split(',').map((n) => n.trim()).filter(Boolean)
    });
  }
  return found;
}

function buildFirefox() {
  const outDir = path.join(DIST, 'firefox');
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  copyRecursive(ROOT, outDir, (src) => !skipForBuild(src));

  // Фон: бандл вместо ES-модульного service worker.
  const bgDir = path.join(outDir, 'background');
  fs.rmSync(path.join(bgDir, 'service-worker.js'), { force: true });
  bundleOne(path.join(bgDir, 'background.js'), {
    entry: path.join(ROOT, 'background', 'service-worker.js'),
    imports: bundledImports('background/service-worker.js')
  });
  fs.rmSync(path.join(outDir, 'core'), { recursive: true, force: true });

  // options и popup импортируют core/settings.js — для Firefox это бандл.
  for (const page of ['options/options.js', 'popup/popup.js']) {
    bundleOne(path.join(outDir, page), { entry: path.join(ROOT, page), imports: bundledImports(page) });
  }

  // Манифест Firefox: background.scripts, без service_worker.
  const ff = structuredClone(manifest);
  ff.background = { scripts: ['background/background.js'] };
  delete ff.minimum_chrome_version;
  ff.browser_specific_settings = {
    gecko: {
      id: 'kuma-improved@local',
      strict_min_version: '115.0'
    }
  };
  // В исходниках встречается браузерный гейт `'clipboard' in navigator` —
  // в Firefox это похоже на обращение к необъявленной переменной clipboard.
  // Строки данных с ним заменяем на функциональный эквивалент.
  const gate = /'clipboard'\s+in\s+navigator/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!gate.test(text)) continue;
      gate.lastIndex = 0;
      fs.writeFileSync(full, text.replace(gate, 'navigator.clipboard != null'));
    }
  };
  walk(outDir);

  // Динамическая регистрация content-скриптов в Firefox ограничена
  // путём без звёздочки: buildMatchPattern() даёт «/threat-hunting*».
  // Для сборки Firefox срезаем завершающую звёздочку в шаблонах.
  const bgFile = path.join(bgDir, 'background.js');
  const bg = fs.readFileSync(bgFile, 'utf8');
  const fixed = bg.replace(/return `\$\{scheme\}:\/\/\$\{target\.host\}\$\{path\}`;/, 'return `${scheme}://${target.host}${path.replace(/\\*+$/, "")}`;');
  if (fixed === bg) console.warn('[firefox] шаблон match pattern не найден — проверьте core/settings.js');
  fs.writeFileSync(bgFile, fixed);

  // web_accessible_resources: то, что объявили модули в files.webAccessible.
  const resources = new Set(manifest.web_accessible_resources.flatMap((r) => r.resources || []));
  for (const mod of fs.readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const mf = path.join(ROOT, 'modules', mod.name, 'module.json');
    if (!fs.existsSync(mf)) continue;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    for (const extra of (m.files && m.files.webAccessible) || []) resources.add(extra);
  }
  ff.web_accessible_resources = [{ resources: [...resources], matches: ['<all_urls>'] }];

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(ff, null, 2) + '\n');

  const out = zip(outDir, path.join(DIST, `kuma-improved-${version}-firefox.zip`));
  console.log(`[firefox]  ${path.relative(ROOT, outDir)} -> ${path.relative(ROOT, out)}`);
}

/* ---------------------------------- main ---------------------------------- */

function main(argv) {
  const only = argv.find((a) => a === '--chromium' || a === '--firefox');
  ensureDir(DIST);

  if (!only || only === '--chromium') buildChromium();
  if (!only || only === '--firefox') buildFirefox();
}

main(process.argv.slice(2));
