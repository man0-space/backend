import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign, verify } from '../auth/token.js';

const pair = generateKeyPairSync('ed25519');
test('application tokens reject wrong audience, expiry and another signer',async()=>{
 const token=await sign(pair.privateKey,'https://api.man0.space','user:verified','token:one',60);
 assert.equal((await verify(token,pair.publicKey,'https://api.man0.space')).sub,'user:verified');
 await assert.rejects(verify(token,pair.publicKey,'https://another.example'));
 await assert.rejects(verify(token,generateKeyPairSync('ed25519').publicKey,'https://api.man0.space'));
 const expired=await sign(pair.privateKey,'https://api.man0.space','user:verified','token:one',-1);
 await assert.rejects(verify(expired,pair.publicKey,'https://api.man0.space'));
});
