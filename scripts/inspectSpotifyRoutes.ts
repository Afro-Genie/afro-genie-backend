import { app } from '../src/app';

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack?: Array<{ name?: string }>;
  };
  name?: string;
  handle?: {
    stack?: Layer[];
  };
};

const layers = ((app as unknown as { _router?: { stack?: Layer[] } })._router?.stack ?? []);
const rows: Array<{ method: string; path: string; handlers: string[] }> = [];

for (const layer of layers) {
  if (layer.route) {
    rows.push({
      method: Object.keys(layer.route.methods).join(',').toUpperCase(),
      path: layer.route.path,
      handlers: (layer.route.stack ?? []).map((s) => s.name ?? 'anonymous')
    });
    continue;
  }

  if (layer.name === 'router' && layer.handle?.stack) {
    for (const sub of layer.handle.stack) {
      if (!sub.route) continue;
      rows.push({
        method: Object.keys(sub.route.methods).join(',').toUpperCase(),
        path: `/api${sub.route.path}`,
        handlers: (sub.route.stack ?? []).map((s) => s.name ?? 'anonymous')
      });
    }
  }
}

for (const row of rows.filter((r) => r.path.includes('/spotify'))) {
  console.log(`${row.method} ${row.path} :: ${row.handlers.join(' -> ')}`);
}
