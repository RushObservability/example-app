const { SpanKind } = require('@opentelemetry/api');
const { performance } = require('node:perf_hooks');

// Reserved .example addresses identify simulated dependencies, never real servers.
function databaseSpanOptions(system, namespace, operation, table) {
  const port = { postgresql: 5432, mysql: 3306, redis: 6379 }[system];
  return { kind: SpanKind.CLIENT, attributes: {
    'db.system': system,
    'db.system.name': system,
    'db.name': namespace,
    'db.namespace': namespace,
    'db.operation': operation,
    'db.operation.name': operation,
    'db.table': table,
    'db.collection.name': table,
    'db.query.summary': `${operation} ${table}`,
    'server.address': `${namespace}-${system}.example`,
    'server.port': port,
    'demo.synthetic': true,
  } };
}

const wireRows = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({
  id, title: `Example row ${id}`, amount: id * 17, active: id % 3 !== 0,
})));
function decodeDatabaseRows() {
  return JSON.parse(wireRows).filter(row => row.active).map(row => ({ ...row, amount: row.amount / 100 }));
}

// Real, bounded CPU work gives the V8 sampler useful application frames. No I/O.
function processDatabaseResult() {
  const configured = Number(process.env.DEMO_DB_CPU_MS ?? 8);
  const budget = Number.isFinite(configured) ? Math.max(0, Math.min(50, configured)) : 8;
  const until = performance.now() + budget;
  let rows = [];
  while (performance.now() < until) rows = decodeDatabaseRows();
  return rows.length;
}

module.exports = { databaseSpanOptions, processDatabaseResult };
