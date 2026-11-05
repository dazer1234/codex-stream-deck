/** Runs inside the renderer. Use only loaded modules: never execute arbitrary factories. */
export async function discoverRendererModules(
  load: (url: string) => Promise<Record<string, any>> = url => import(url)
): Promise<{
  namespaces: Record<string, any>[];
  slotNamespaces: Record<string, any>[];
}> {
  const urls = [...new Set([
    ...Array.from(document.querySelectorAll<HTMLLinkElement & HTMLScriptElement>('link[href], script[src]'), element => element.href || element.src),
    ...performance.getEntriesByType('resource').map(entry => entry.name)
  ])].filter(url => url.includes('/assets/') && url.endsWith('.js'));
  const namespaces: Record<string, any>[] = [];
  const slotNamespaces: Record<string, any>[] = [];
  for (const url of urls) {
    try {
      const namespace = await load(url);
      namespaces.push(namespace);
      if (url.includes('/codex-micro-slot-signals-')) slotNamespaces.push(namespace);
      const runtime = namespace.__webpack_require__;
      if (typeof runtime !== 'function' || !runtime.c || !runtime.m) continue;
      for (const [id, cached] of Object.entries(runtime.c) as [string, any][]) {
        const exports = cached?.exports;
        if (!exports || cached.error) continue;
        // A cache can contain browser globals whose properties are inaccessible.
        const safe: Record<string, any> = {};
        for (const key of Object.keys(exports)) {
          try {
            const value = exports[key];
            if (value && typeof value === 'object') {
              void value.handlers; void value.layout; void value.resolve;
            }
            safe[key] = value;
          } catch { /* Ignore throwing getters and cross-origin Window exports. */ }
        }
        namespaces.push(safe);
        const source = Function.prototype.toString.call(runtime.m[id] ?? (() => {}));
        if (source.includes('inactivityTimeoutMs:') && source.includes('voiceState:') && source.includes('slots:')) {
          slotNamespaces.push(safe);
        }
      }
      // The entry owns the complete loaded cache; don't import every async chunk.
      return { namespaces, slotNamespaces };
    } catch { /* Ignore unrelated renderer resources. */ }
  }
  return { namespaces, slotNamespaces };
}

export function rendererModulesExpression(): string {
  return `(${discoverRendererModules.toString()})()`;
}
