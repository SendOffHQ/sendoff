// A stand-in for D1, shared by the tests that need a database but are not
// about the database.
//
// Race writes go to D1 and nowhere else, so every test that saves a race needs
// one. The tests that are about D1 itself (d1-writes, d1-mirror, d1-reads)
// keep their own stubs, which they inspect closely; this one is for the rest.
//
// It understands the statements the worker issues and nothing more, matched by
// shape. An unknown statement throws, so a new query in the worker fails a
// test loudly instead of quietly returning nothing and passing it.
//
//   import { fakeD1 } from './fake-d1.mjs';
//   const DB = fakeD1();
//   DB.races.get('my-race')   // the stored row, for assertions
export function fakeD1() {
  const races = new Map();       // slug -> row
  const people = new Map();      // slug -> [{ email, role }]
  const legs = new Map();        // slug -> Map(runner\0idx -> row)
  const media = new Map();       // id -> row
  const row = slug => races.get(slug) ||
    races.set(slug, { slug, name: '', location: null, start_time: null, visibility: 'public',
      created_by: '', config: '{}', config_sha: null, data: '{}', data_sha: null }).get(slug);
  const norm = sql => sql.replace(/\s+/g, ' ').trim();

  function exec(sql, a) {
    let m;
    // ---- races
    if (/^INSERT INTO races \(slug, name, location, start_time, visibility, created_by, config, config_sha/.test(sql)) {
      const [slug, name, location, start, visibility, createdBy, config, sha] = a;
      Object.assign(row(slug), { name, location, start_time: start, visibility, created_by: createdBy,
        config, config_sha: sha ?? null });
      return { changes: 1 };
    }
    if (/^INSERT INTO races \(slug, name, created_by, config, data, data_sha/.test(sql)) {
      const [slug, data, sha] = a;
      Object.assign(row(slug), { data, data_sha: sha ?? null });
      return { changes: 1 };
    }
    if ((m = sql.match(/^UPDATE races SET (config_sha|data_sha) = \? WHERE slug = \? AND \(\1 IS \? OR \1 IS NULL\)$/))) {
      const [token, slug, expected] = a;
      const r = races.get(slug);
      const cur = r ? (r[m[1]] ?? null) : null;
      if (!r || (cur !== null && cur !== (expected ?? null))) return { changes: 0 };
      r[m[1]] = token;
      return { changes: 1 };
    }
    if ((m = sql.match(/^UPDATE races SET (config_sha|data_sha) = \? WHERE slug = \?$/))) {
      const r = races.get(a[1]); if (r) r[m[1]] = a[0] ?? null;
      return { changes: r ? 1 : 0 };
    }
    if ((m = sql.match(/^UPDATE races SET (config_sha|data_sha) = NULL WHERE slug = \?$/))) {
      const r = races.get(a[0]); if (r) r[m[1]] = null;
      return { changes: r ? 1 : 0 };
    }
    if (sql === 'UPDATE races SET created_by = ? WHERE slug = ?') {
      const r = races.get(a[1]); if (r) r.created_by = a[0];
      return { changes: r ? 1 : 0 };
    }
    if (sql === 'DELETE FROM races WHERE slug = ?') { races.delete(a[0]); return { changes: 1 }; }
    // ---- race_people
    if (sql === 'DELETE FROM race_people WHERE slug = ?') { people.delete(a[0]); return { changes: 1 }; }
    if (/^INSERT INTO race_people \(slug, email, role\)/.test(sql)) {
      const list = people.get(a[0]) || people.set(a[0], []).get(a[0]);
      const i = list.findIndex(p => p.email === a[1]);
      if (i >= 0) list[i] = { email: a[1], role: a[2] }; else list.push({ email: a[1], role: a[2] });
      return { changes: 1 };
    }
    // ---- legs
    if (/^INSERT INTO legs /.test(sql)) {
      const [slug, runner, idx] = a;
      const t = legs.get(slug) || legs.set(slug, new Map()).get(slug);
      t.set(`${runner}\0${idx}`, { slug, runner_id: runner, idx, raw: a[11] });
      return { changes: 1 };
    }
    if (/^DELETE FROM legs WHERE slug = \? AND/.test(sql)) {
      const keep = new Set(JSON.parse(a[1] || '[]'));
      const t = legs.get(a[0]);
      if (t) for (const k of [...t.keys()]) if (!keep.has(k)) t.delete(k);
      return { changes: 1 };
    }
    if (sql === 'DELETE FROM legs WHERE slug = ?') { legs.delete(a[0]); return { changes: 1 }; }
    // ---- media
    if (/^INSERT INTO media /.test(sql)) {
      const cols = ['id','slug','leg_idx','runner_id','r2_key','content_type','bytes','width','height','caption','created_by','created_at'];
      media.set(a[0], Object.fromEntries(cols.map((c, i) => [c, a[i] ?? null])));
      return { changes: 1 };
    }
    if (sql === 'DELETE FROM media WHERE id = ?') { media.delete(a[0]); return { changes: 1 }; }
    if (sql === 'DELETE FROM media WHERE slug = ?') {
      for (const [id, r] of media) if (r.slug === a[0]) media.delete(id);
      return { changes: 1 };
    }
    return null;
  }

  function query(sql, a) {
    const r = a.length ? races.get(a[0]) : null;
    if (sql === 'SELECT slug FROM races WHERE slug = ?') return r ? [{ slug: r.slug }] : [];
    if (sql === 'SELECT slug FROM races') return [...races.keys()].map(slug => ({ slug }));
    if (sql === 'SELECT data FROM races WHERE slug = ?') return r ? [{ data: r.data }] : [];
    if (sql === 'SELECT created_by FROM races WHERE slug = ?') return r ? [{ created_by: r.created_by }] : [];
    if (sql === 'SELECT config, config_sha FROM races WHERE slug = ?') return r ? [{ config: r.config, config_sha: r.config_sha }] : [];
    if (sql === 'SELECT config, config_sha, data, data_sha FROM races WHERE slug = ?') return r ? [r] : [];
    if (sql === 'SELECT email, role FROM race_people WHERE slug = ?') return (people.get(a[0]) || []).slice();
    if (sql === 'SELECT count(*) AS c FROM races') return [{ c: races.size }];
    if (sql === 'SELECT count(*) AS c FROM race_people') return [{ c: [...people.values()].reduce((n, l) => n + l.length, 0) }];
    if (sql === 'SELECT count(*) AS c FROM legs') return [{ c: [...legs.values()].reduce((n, t) => n + t.size, 0) }];
    if (sql === 'SELECT count(*) AS c FROM race_people WHERE slug = ?') return [{ c: (people.get(a[0]) || []).length }];
    if (sql === 'SELECT count(*) AS c FROM legs WHERE slug = ?') return [{ c: (legs.get(a[0]) || new Map()).size }];
    if (/^SELECT slug, name, created_by, config_sha, data_sha, config IS NOT NULL/.test(sql)) {
      return [...races.values()].map(x => ({ slug: x.slug, name: x.name, created_by: x.created_by,
        config_sha: x.config_sha, data_sha: x.data_sha,
        has_config: x.config && x.config !== '{}' ? 1 : 0, has_data: x.data && x.data !== '{}' ? 1 : 0 }));
    }
    if (sql === 'SELECT COUNT(*) AS n FROM media WHERE slug = ?') return [{ n: [...media.values()].filter(m => m.slug === a[0]).length }];
    if (/^SELECT \* FROM media WHERE slug = \?/.test(sql)) {
      return [...media.values()].filter(m => m.slug === a[0])
        .sort((x, y) => (x.leg_idx - y.leg_idx) || String(x.created_at).localeCompare(String(y.created_at)));
    }
    if (sql === 'SELECT * FROM media WHERE id = ?') return media.has(a[0]) ? [media.get(a[0])] : [];
    if (sql === 'SELECT r2_key FROM media WHERE slug = ?') return [...media.values()].filter(m => m.slug === a[0]).map(m => ({ r2_key: m.r2_key }));
    return null;
  }

  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...a) => statement(sql, a),
    async all() {
      const res = query(sql, args);
      if (res == null) throw new Error('fake-d1 does not know: ' + sql);
      return { results: res };
    },
    async first(col) {
      const res = query(sql, args);
      if (res == null) throw new Error('fake-d1 does not know: ' + sql);
      const r = res[0] || null;
      return r && col ? r[col] : r;
    },
    async run() {
      const res = exec(sql, args);
      if (res == null) throw new Error('fake-d1 does not know: ' + sql);
      return { meta: res, success: true };
    }
  });

  return {
    races, people, legs, media,
    prepare: sql => statement(norm(sql)),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  };
}
