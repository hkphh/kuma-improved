/**
 * Ядро тестера функций KUMA.
 *
 * Изолировано в IIFE и публикует API через globalThis.__KUMA_WEB_TESTER__,
 * чтобы не пересекаться с другими модулями расширения.
 */
(function () {
  'use strict';

  // ---------- Стандартные поля событий KUMA ----------

  /**
   * Стандартные поля события KUMA. Пишутся без $ и подставляются из
   * события; всё остальное (my_var2026 и т.п.) — переменные, которые
   * задаются в окне песочницы. Список из интерфейса KUMA (e.<Field>).
   */
  const KUMA_FIELDS = `
    AffectedAssets AggregationRuleID AggregationRuleName ApplicationProtocol AttackerHostID
    AttackerUserID BaseEventCount BaseEvents BytesIn BytesOut Code CorrelationRuleID
    CorrelationRuleName DestinationAccountID DestinationAddress DestinationAssetID
    DestinationAssetKSCHostID DestinationAssetKSCInstanceID DestinationCity DestinationCountry
    DestinationDnsDomain DestinationHostName DestinationLatitude DestinationLongitude
    DestinationMacAddress DestinationNtDomain DestinationPort DestinationProcessID
    DestinationProcessName DestinationRegion DestinationServiceName DestinationTranslatedAddress
    DestinationTranslatedPort DestinationUserID DestinationUserName DestinationUserPrivileges
    DeviceAction DeviceAddress DeviceAssetID DeviceAssetKSCHostID DeviceAssetKSCInstanceID
    DeviceCity DeviceCountry DeviceCustomDate1 DeviceCustomDate1Label DeviceCustomDate2
    DeviceCustomDate2Label DeviceCustomFloatingPoint1 DeviceCustomFloatingPoint1Label
    DeviceCustomFloatingPoint2 DeviceCustomFloatingPoint2Label DeviceCustomFloatingPoint3
    DeviceCustomFloatingPoint3Label DeviceCustomFloatingPoint4 DeviceCustomFloatingPoint4Label
    DeviceCustomIPv6Address1 DeviceCustomIPv6Address1Label DeviceCustomIPv6Address2
    DeviceCustomIPv6Address2Label DeviceCustomIPv6Address3 DeviceCustomIPv6Address3Label
    DeviceCustomIPv6Address4 DeviceCustomIPv6Address4Label DeviceCustomNumber1
    DeviceCustomNumber1Label DeviceCustomNumber2 DeviceCustomNumber2Label DeviceCustomNumber3
    DeviceCustomNumber3Label DeviceCustomString1 DeviceCustomString1Label DeviceCustomString2
    DeviceCustomString2Label DeviceCustomString3 DeviceCustomString3Label DeviceCustomString4
    DeviceCustomString4Label DeviceCustomString5 DeviceCustomString5Label DeviceCustomString6
    DeviceCustomString6Label DeviceDirection DeviceDnsDomain DeviceEventCategory
    DeviceEventClassID DeviceExternalID DeviceFacility DeviceHostName DeviceInboundInterface
    DeviceLatitude DeviceLongitude DeviceMacAddress DeviceNtDomain DeviceOutboundInterface
    DevicePayloadID DeviceProcessID DeviceProcessName DeviceProduct DeviceReceiptTime
    DeviceRegion DeviceTimeZone DeviceTranslatedAddress DeviceVendor DeviceVersion EndTime
    EventOutcome ExternalID Extra F FA FileCreateTime FileHash FileID FileModificationTime
    FileName FilePath FilePermission FileSize FileType FlexDate1 FlexDate1Label FlexNumber1
    FlexNumber1Label FlexNumber2 FlexNumber2Label FlexString1 FlexString1Label FlexString2
    FlexString2Label GroupedBy ID Message N NA Name OldFileCreateTime OldFileHash OldFileID
    OldFileModificationTime OldFileName OldFilePath OldFilePermission OldFileSize OldFileType
    Priority Raw Reason ReplayID RequestClientApplication RequestContext RequestCookies
    RequestMethod RequestUrl S SA ServiceID ServiceName Severity SourceAccountID SourceAddress
    SourceAssetID SourceAssetKSCHostID SourceAssetKSCInstanceID SourceCity SourceCountry
    SourceDnsDomain SourceHostName SourceLatitude SourceLongitude SourceMacAddress
    SourceNtDomain SourcePort SourceProcessID SourceProcessName SourceRegion SourceServiceName
    SourceTranslatedAddress SourceTranslatedPort SourceUserID SourceUserName
    SourceUserPrivileges SpaceID StartTime TI Tactic Technique TenantID Timestamp
    TransportProtocol Type VictimHostID VictimUserID`
  .trim().split(/\s+/);

  const KUMA_FIELD_SET = new Set(KUMA_FIELDS);

  /** Стандартное ли это поле KUMA (без учёта регистра). */
  function isKumaField(name) {
    if (KUMA_FIELD_SET.has(name)) return true;
    const lower = String(name).toLowerCase();
    return KUMA_FIELDS.some(f => f.toLowerCase() === lower);
  }

  // ---------- Парсер выражений ----------
  // ---------- Парсер выражений ----------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$.]*/;
const NUM_RE = /^\d+(?:\.\d+)?/;

class Parser {
  constructor(input, variables) {
    this.tokens = this.tokenize(input);
    this.pos = 0;
    this.variables = variables;
  }

  /**
   * Лексер. Если найдена незакрытая кавычка (разделитель SQL, обратная
   * кавычка или обычная одинарная кавычка без закрывающей), символ
   * считается частью идентификатора — так же его воспринимает KUMA.
   *   '.*            -> идентификатор '.*      (квотированный разделитель)
   *   `foo`          -> идентификатор `foo`
   *   'abc' / "abc"  -> строковый литерал
   */
  tokenize(str) {
    const tokens = [];
    let i = 0;

    const readQuoted = (quote, isTerminator) => {
      let j = i + 1;
      while (j < str.length && !isTerminator(str[j], quote)) j++;
      return j < str.length ? str.slice(i, j + 1) : null;
    };

    while (i < str.length) {
      const ch = str[i];

      if (/\s/.test(ch)) { i++; continue; }

      // Строковый литерал в одинарных кавычках. Если кавычка не закрыта —
      // это разделитель, а не строка.
      if (ch === "'") {
        const raw = readQuoted(ch, (c) => c === "'");
        if (raw !== null) { tokens.push(raw); i += raw.length; continue; }
      }

      // Строковый литерал в двойных кавычках (незакрытая тоже = литерал).
      if (ch === '"') {
        const raw = readQuoted(ch, (c) => c === '"') || str.slice(i);
        tokens.push(raw);
        i += raw.length;
        continue;
      }

      // Квотированный идентификатор в обратных кавычках.
      if (ch === '`') {
        const raw = readQuoted(ch, (c) => c === '`');
        if (raw !== null) { tokens.push(raw); i += raw.length; continue; }
        tokens.push(str.slice(i));
        break;
      }

      const three = str.slice(i, i + 3).toUpperCase();
      if (three === 'AND' || (three === 'OR' && /[\s(]/.test(str[i + 3] || ' '))) {
        const prev = i === 0 ? '' : str[i - 1];
        const after = str[i + 3] || '';
        if (!/[A-Za-z0-9_$.]/.test(prev) && !/[A-Za-z0-9_$.]/.test(after)) {
          tokens.push(three);
          i += 3;
          continue;
        }
      }

      const two = str.slice(i, i + 2);
      if (['>=', '<=', '!=', '==', '<>', '=~'].includes(two)) {
        tokens.push(two);
        i += 2;
        continue;
      }

      if ('()+-*/%,'.includes(ch)) {
        tokens.push(ch);
        i++;
        continue;
      }

      if ('=<>!'.includes(ch)) {
        tokens.push(ch);
        i++;
        continue;
      }

      const num = NUM_RE.exec(str.slice(i));
      if (num) {
        tokens.push(num[0]);
        i += num[0].length;
        continue;
      }

      const ident = IDENT_RE.exec(str.slice(i));
      tokens.push(ident[0]);
      i += ident[0].length;
      continue;
    }

    return tokens;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(t) {
    const tok = this.next();
    if (tok !== t) throw new Error(`Ожидалось "${t}", получено "${tok}"`);
  }

  parse() {
    const expr = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error(`Неожиданный токен: "${this.peek()}"`);
    }
    return expr;
  }

  parseExpression() {
    let left = this.parseTerm();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.next();
      const right = this.parseTerm();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  parseTerm() {
    let left = this.parseFactor();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.next();
      const right = this.parseFactor();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  /**
   * Дочитывает «голое» условие внутри вызова функции до следующей запятой
   * или закрывающей скобки и превращает его в строковый литерал.
   * Пример: $my_var2026 LIKE '.*'  ->  "$my_var2026 LIKE '.*'"
   */
  /**
   * Если после аргумента осталось «голое» условие (`$a LIKE '.*'`), дочитывает
   * его и объединяет с уже разобранным первым операндом.
   */
  maybeBareCondition(previous) {
    if (this.peek() === undefined || this.peek() === ')' || this.peek() === ',') return previous;
    return this.parseBareCondition(previous);
  }

  parseBareCondition(previous) {
    const parts = [];
    if (previous && previous.type === 'var') parts.push('$' + previous.name);
    else if (previous && previous.type === 'string') parts.push(previous.value);
    else if (previous && previous.type === 'number') parts.push(String(previous.value));
    else if (previous && previous.type === 'bool') parts.push(previous.value ? 'true' : 'false');
    else if (previous && previous.type === 'binary') parts.push(renderNode(previous));
    else if (previous && previous.type === 'call') parts.push(renderNode(previous));
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '(') depth++;
      if (token === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (token === ',' && depth === 0) break;
      parts.push(this.next());
    }
    return { type: 'string', value: parts.join(' ') };
  }

  parseFactor() {
    const tok = this.peek();

    if (tok === undefined) throw new Error('Неожиданный конец выражения');

    // Число
    if (/^\d/.test(tok)) {
      this.next();
      return { type: 'number', value: parseFloat(tok) };
    }

    // Строка в кавычках (обычные или квотированный идентификатор)
    if (tok.startsWith("'") || tok.startsWith('"') || tok.startsWith('`')) {
      this.next();
      const closed = tok.length > 1 && tok.endsWith(tok[0]);
      return { type: 'string', value: closed ? tok.slice(1, -1) : tok.slice(1) };
    }

    // Вызов функции: имя без $ (а также без кавычек).
    if (/^[A-Za-z_]/.test(tok) && !/^(AND|OR)$/.test(tok) && this.tokens[this.pos + 1] === '(') {
      const name = this.next();
      this.next(); // '('
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined) {
        args.push(this.maybeBareCondition(this.parseExpression()));
        if (this.peek() === ',') {
          this.next();
          continue;
        }
        break;
      }
      this.expect(')');
      return { type: 'call', name, args };
    }

    // Переменная с явным $: $my_var.
    if (/^\$[A-Za-z0-9_]/.test(tok)) {
      return { type: 'var', name: this.next().slice(1) };
    }

    if (tok === 'true') { this.next(); return { type: 'bool', value: true }; }
    if (tok === 'false') { this.next(); return { type: 'bool', value: false }; }

    // Переменная: $my_var или стандартное поле KUMA (SourceUserName и т.п.).
    // Значение берётся из окна песочницы; если его нет, а имя — стандартное
    // поле, оно считается полем события (см. evaluate).
    if (/^[A-Za-z_]/.test(tok)) {
      const name = this.next();
      const vars = this.variables || {};
      const isKnown = Object.prototype.hasOwnProperty.call(vars, name);
      if (isKnown || isKumaField(name)) {
        return { type: 'var', name };
      }
      // Имя не определено и это не поле KUMA — обычная строка.
      return { type: 'string', value: name };
    }

    // Скобки
    if (tok === '(') {
      this.next();
      const expr = this.parseExpression();
      this.expect(')');
      return expr;
    }

    throw new Error(`Неожиданный токен: "${tok}"`);
  }
}

function renderNode(node) {
  switch (node.type) {
    case 'number': return String(node.value);
    case 'bool': return node.value ? 'true' : 'false';
    case 'string': return /^[A-Za-z_]\w*$/.test(node.value) ? node.value : "'" + node.value + "'";
    case 'var': return '$' + node.name;
    case 'binary': return renderNode(node.left) + ' ' + node.op + ' ' + renderNode(node.right);
    case 'call': return node.name + '(' + node.args.map(renderNode).join(', ') + ')';
  }
  return '';
}

// ---------- Вычисление ----------

function evaluate(node, vars) {
  switch (node.type) {
    case 'number': return node.value;
    case 'string': return node.value;
    case 'bool': return node.value;
    case 'var': {
      const name = node.name;
      if (name in vars) return vars[name];
      // Стандартное поле KUMA без заданного значения — поле события.
      if (isKumaField(name)) return '';
      throw new Error(`Переменная "${name}" не задана`);
    }
    case 'binary': {
      const l = evaluate(node.left, vars);
      const r = evaluate(node.right, vars);
      const ln = typeof l === 'number' ? l : parseFloat(l) || 0;
      const rn = typeof r === 'number' ? r : parseFloat(r) || 0;
      switch (node.op) {
        case '+': return ln + rn;
        case '-': return ln - rn;
        case '*': return ln * rn;
        case '/': return rn === 0 ? 0 : ln / rn;
        case '%': return rn === 0 ? 0 : ln % rn;
      }
      break;
    }
    case 'call':
      return callFunction(node.name, node.args, vars);
  }
  throw new Error(`Неизвестный узел: ${node.type}`);
}

// ---------- Реализация функций KUMA ----------

function callFunction(name, argNodes, vars) {
  const args = argNodes.map(n => evaluate(n, vars));

  switch (name) {
    // ----- Строковые -----
    case 'len':
      if (typeof args[0] === 'string') return args[0].length;
      if (Array.isArray(args[0])) return args[0].length;
      return String(args[0]).length;

    case 'to_lower':
      return String(args[0]).toLowerCase();

    case 'to_upper':
      return String(args[0]).toUpperCase();

    case 'append':
      return String(args[0]) + String(args[1]);

    case 'prepend':
      return String(args[1]) + String(args[0]);

    case 'substring': {
      const s = String(args[0]);
      const start = parseInt(args[1], 10) || 0;
      if (args.length >= 3) {
        const end = parseInt(args[2], 10);
        return s.substring(start, end);
      }
      return s.substring(start);
    }

    case 'index_of':
      return String(args[1]).indexOf(String(args[0]));

    case 'last_index_of':
      return String(args[1]).lastIndexOf(String(args[0]));

    case 'tr': {
      const s = String(args[0]);
      const chars = args.length >= 2 ? String(args[1]) : ' ';
      let start = 0, end = s.length;
      while (start < end && chars.includes(s[start])) start++;
      while (end > start && chars.includes(s[end - 1])) end--;
      return s.substring(start, end);
    }

    case 'replace':
      return String(args[0]).split(String(args[1])).join(String(args[2]));

    case 'regexp_replace': {
      const flag = args[3] === true || args[3] === 'all' ? 'g' : '';
      const re = new RegExp(String(args[1]), flag);
      return String(args[0]).replace(re, String(args[2]));
    }

    case 'regexp_capture': {
      const re = new RegExp(String(args[1]));
      const m = String(args[0]).match(re);
      return m ? m[0] : '';
    }

    case 'str_join': {
      const sep = String(args[0]);
      return args.slice(1).map(String).join(sep);
    }

    case 'template': {
      if (args.length === 1) {
        return String(args[0]).replace(/\{\{\.(\w+)\}\}/g, (_, v) => {
          return vars[v] !== undefined ? String(vars[v]) : '';
        });
      }
      return String(args[0]).replace(/\{\{index \. (\d+)\}\}/g, (_, i) => {
        const idx = parseInt(i, 10) + 1;
        return idx < args.length ? String(args[idx]) : '';
      });
    }

    // ----- Массивы -----
    case 'distinct_items': {
      const arr = Array.isArray(args[0]) ? args[0] : String(args[0]).split('');
      return [...new Set(arr)];
    }

    case 'sort_items': {
      const arr = Array.isArray(args[0]) ? [...args[0]] : String(args[0]).split('');
      const dir = args[1] === 'desc' ? -1 : 1;
      arr.sort((a, b) => {
        if (a < b) return -1 * dir;
        if (a > b) return 1 * dir;
        return 0;
      });
      return arr;
    }

    case 'item': {
      const idx = parseInt(args[1], 10);
      if (Array.isArray(args[0])) return args[0][idx] ?? '';
      return String(args[0])[idx] ?? '';
    }

    case 'math_min': {
      const arr = Array.isArray(args[0]) ? args[0] : [args[0]];
      return Math.min(...arr.map(Number));
    }

    case 'math_max': {
      const arr = Array.isArray(args[0]) ? args[0] : [args[0]];
      return Math.max(...arr.map(Number));
    }

    case 'math_avg': {
      const arr = Array.isArray(args[0]) ? args[0] : [args[0]];
      const nums = arr.map(Number);
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }

    // ----- Математические -----
    case 'round':
      return Math.round(Number(args[0]));

    case 'ceil':
      return Math.ceil(Number(args[0]));

    case 'floor':
      return Math.floor(Number(args[0]));

    case 'abs':
      return Math.abs(Number(args[0]));

    case 'pow':
      return Math.pow(Number(args[0]), Number(args[1]));

    // ----- Условные -----
    case 'conditional':
      return evalCondition(String(args[0]), vars) ? args[1] : args[2];

    // ----- Время (упрощённо) -----
    case 'now':
      return Date.now();

    case 'parse_timestamp':
      return new Date(String(args[0])).getTime();

    case 'format_timestamp': {
      const d = new Date(Number(args[0]));
      return d.toISOString();
    }

    case 'extract_from_timestamp': {
      const d = new Date(Number(args[0]));
      const fmt = String(args[1]);
      switch (fmt) {
        case 'y': return d.getUTCFullYear();
        case 'M': return d.getUTCMonth() + 1;
        case 'd': return d.getUTCDate();
        case 'h': return d.getUTCHours();
        case 'm': return d.getUTCMinutes();
        case 's': return d.getUTCSeconds();
        case 'wd': return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
        default: return '';
      }
    }

    case 'time_diff': {
      const end = Number(args[0]);
      const start = Number(args[1]);
      const unit = args[2] || 'ms';
      const diff = end - start;
      switch (unit) {
        case 'ms': return diff;
        case 's': return Math.floor(diff / 1000);
        case 'm': return Math.floor(diff / 60000);
        case 'h': return Math.floor(diff / 3600000);
        case 'd': return Math.floor(diff / 86400000);
        default: return diff;
      }
    }

    case 'truncate_timestamp': {
      const ts = Number(args[0]);
      const unit = args[1] || '1s';
      const ms = { '1s': 1000, '1m': 60000, '1h': 3600000, '24h': 86400000 }[unit] || 1000;
      return Math.floor(ts / ms) * ms;
    }

    default:
      throw new Error(`Функция "${name}" не реализована`);
  }
}

// ---------- Условные выражения (SQL-подобный синтаксис KUMA) ----------

const COND_RE = /^\s*((?:'[^']*'|`[^`]*`|"[^"]*"|[^\s'])+?)\s*(NOT\s+ILIKE|NOT\s+LIKE|ILIKE|LIKE|<>|!=|=|>=|<=|>|<)\s*(.+?)\s*$/is;

/**
 * Разбирает условие вида `$var LIKE '-.*' [AND|OR ...]`.
 * Поддерживает префикс $ у переменных, квотированные разделители
 * ('-.*', '.*', `foo`) и сами значения в кавычках.
 */
function evalCondition(cond, vars) {
  const orParts = splitCondition(cond, 'OR');
  if (orParts.length > 1) return orParts.some(p => evalAndGroup(p, vars));
  return evalAndGroup(cond, vars);
}

function evalAndGroup(cond, vars) {
  const parts = splitCondition(cond, 'AND');
  return parts.every(p => evalSimpleCondition(p, vars));
}

function splitCondition(cond, keyword) {
  const re = new RegExp(`\\s+${keyword}\\s+`, 'i');
  return cond.split(re).filter(p => p.trim() !== '');
}

/**
 * Необязательный третий аргумент — регулярное выражение, которым
 * проверяется значение переменной. Полезно для «конструкции» вроде
 * `regexp:'.$event.UserName.IsNotWhitespace()` — ограничения KUMA,
 * которые невозможно выполнить без события, игнорируются.
 */
function evalSimpleCondition(cond, vars, extraRegexp) {
  let rest = String(cond).trim();
  let pattern = extraRegexp ? String(extraRegexp) : null;

  const m = rest.match(COND_RE);
  if (!m) {
    if (pattern) return compileSafeRe(pattern).test(stripVar(rest));
    return false;
  }

  const field = unquote(m[1].trim());
  const op = m[2].replace(/\s+/g, ' ').toUpperCase();
  let val = m[3].trim();

  // В кавычках может быть как значение, так и регулярное выражение.
  const quoted = val.match(/^(['"`])(.*)\1$/s) || val.match(/^(['"`])(.*)$/s);
  if (quoted) val = quoted[2];

  const isPattern = op === 'LIKE' || op === 'ILIKE' || op === '=~';
  if (!pattern && isPattern) pattern = val;

  // Если переменной нет в окне песочницы, сравниваем с регулярным
  // литералом (например, `regexp:'.$event.X.IsNotWhitespace()`).
  const fieldVal = field in vars ? String(vars[field]) : stripVar(field);

  switch (op) {
    case '=':
      if (field in vars) return fieldVal === val;
      return compileSafeRe(escapeRegex(val)).test(fieldVal);
    case '!=':
    case '<>':
      if (field in vars) return fieldVal !== val;
      return !compileSafeRe(escapeRegex(val)).test(fieldVal);
    case '=~':
    case 'LIKE':
      return compileSafeRe(pattern).test(fieldVal);
    case 'ILIKE':
      return compileSafeRe(pattern, 'i').test(fieldVal);
    case 'NOT LIKE':
      return !compileSafeRe(pattern).test(fieldVal);
    case 'NOT ILIKE':
      return !compileSafeRe(pattern, 'i').test(fieldVal);
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const a = parseFloat(fieldVal);
      const b = parseFloat(val);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        const cmp = fieldVal < val ? -1 : fieldVal > val ? 1 : 0;
        if (op === '>') return cmp > 0;
        if (op === '>=') return cmp >= 0;
        if (op === '<') return cmp < 0;
        return cmp <= 0;
      }
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      if (op === '<') return a < b;
      return a <= b;
    }
  }
  return false;
}

/**
 * KUMA-ограничение, которое не задано в окне песочницы (например,
 * `$event.UserName.IsNotWhitespace()`), — вырезаем префиксы и суффиксы,
 * оставляя имя переменной. Если значение неизвестно, паттерн применится
 * к самому имени — это честный ответ «условие не подтверждено».
 */
function stripVar(name) {
  return String(name).trim().replace(/^\$/, '').replace(/\.[A-Za-z_]\w*\(\)$/, '');
}

function unquote(s) {
  return String(s).trim().replace(/^\$/, '').replace(/^(['"`])(.*)\1$/s, '$2');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSafeRe(pattern, flags) {
  const src = String(pattern);
  const tryList = [
    src,
    // SQL-классы эквивалентности и «любые символы кроме перевода строки».
    src.replace(/\[:alnum:\]/g, 'A-Za-z0-9').replace(/\[:alpha:\]/g, 'A-Za-z')
       .replace(/\[:digit:\]/g, '0-9').replace(/\[:space:\]/g, '\\s'),
    escapeRegex(src)
  ];
  for (const candidate of tryList) {
    try {
      return new RegExp('^' + candidate + '$', flags || '');
    } catch (e) { /* следующий вариант */ }
  }
  return /(?!)/;
}

  globalThis.__KUMA_WEB_TESTER__ = {
    Parser,
    evaluate,
    callFunction,
    evalCondition,
    evalSimpleCondition
  };
})();
