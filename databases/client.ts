import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { config } from '../config.js';
import * as schema from './schema.js';
export const user = neon(config.users);
export const workflow = neon(config.workflows);
export const userDb = drizzle(user, { schema: { users: schema.users, tokens: schema.tokens, consents: schema.consents } });
export const workflowDb = drizzle(workflow, { schema: { workflows: schema.workflows } });
