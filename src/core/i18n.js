/**
 * Localization. Catalog-based, plural-aware, locale ≠ language (pt-BR != pt-PT).
 * Resolution: exact locale -> language -> fallback locale -> key itself.
 */

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

export class I18n {
  constructor({ catalogs = {}, locale = 'pt-BR', fallback = 'en' } = {}) {
    this.catalogs = catalogs;
    this.locale = locale;
    this.fallback = fallback;
    this.listeners = new Set();
    this._rules = new Map();
    this._cache = new Map();
  }

  static async load(urls, { locale = 'pt-BR', fallback = 'en' } = {}) {
    const entries = await Promise.all(
      Object.entries(urls).map(async ([code, url]) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`failed to load locale ${code}: ${res.status}`);
        return [code, await res.json()];
      }),
    );
    return new I18n({ catalogs: Object.fromEntries(entries), locale, fallback });
  }

  get available() {
    return Object.keys(this.catalogs);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setLocale(code) {
    if (!this.catalogs[code]) return false;
    this.locale = code;
    this._cache.clear();
    for (const fn of this.listeners) fn(code);
    return true;
  }

  _catalogFor(code) {
    if (this.catalogs[code]) return this.catalogs[code];
    const lang = code.split('-')[0];
    if (this.catalogs[lang]) return this.catalogs[lang];
    return null;
  }

  has(key) {
    return this._resolve(this.locale, key) !== undefined;
  }

  _resolve(locale, key) {
    const chain = [locale, locale.split('-')[0], this.fallback];
    for (const code of chain) {
      const cat = this._catalogFor(code);
      if (cat && key in cat) return cat[key];
    }
    return undefined;
  }

  /** Translate + interpolate. `{name}` placeholders; plural via {one, other}. */
  t(key, args = {}) {
    const entry = this._resolve(this.locale, key);
    if (entry === undefined) {
      if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
      return key;
    }
    let value = entry;
    if (value && typeof value === 'object') {
      const n = Number(args.n ?? args.count ?? 0);
      const rules = this._rules.get(this.locale) ?? new Intl.PluralRules(this.locale);
      this._rules.set(this.locale, rules);
      const form = rules.select(n);
      value = value[form] ?? value.other ?? value.one ?? Object.values(value)[0] ?? key;
    }
    return String(value).replace(/\{(\w+)\}/g, (m, name) => {
      const v = args[name];
      if (v === undefined) return m;
      if (typeof v === 'number' && args.format !== false) return this.number(v);
      return String(v);
    });
  }

  number(n, opts = {}) {
    return new Intl.NumberFormat(this.locale, opts).format(n);
  }

  /** Fill [data-loc] nodes in a subtree. */
  apply(root = document) {
    for (const el of root.querySelectorAll('[data-loc]')) {
      const key = el.getAttribute('data-loc');
      const text = this.t(key);
      if (el.hasAttribute('data-loc-attr')) el.setAttribute(el.getAttribute('data-loc-attr'), text);
      else el.textContent = text;
    }
    for (const el of root.querySelectorAll('[data-loc-title]')) {
      el.title = this.t(el.getAttribute('data-loc-title'));
    }
    document.documentElement.lang = this.locale;
    document.documentElement.dir = /^(ar|he|fa|ur)/.test(this.locale) ? 'rtl' : 'ltr';
  }
}

export { PLURAL_FORMS };
