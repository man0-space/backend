import { user, workflow } from './databases/client.js';
import { ready, close, cache, composer } from './databases/cache.js';
await ready();
try { const [users, workflows, cached, drafts] = await Promise.all([user`SELECT count(*) FROM users`, workflow`SELECT count(*) FROM workflows`, cache.ping(), composer.ping()]); console.log({ users: Number(users[0].count), workflows: Number(workflows[0].count), cache: cached, composer: drafts }); } finally { await close(); }
